import type { Prisma } from '@/generated/prisma/client';
import type { AiSuggestion, SuggestionStatus } from '@/generated/prisma/client';
import { estimateCostCny, env } from '@/lib/env';
import { prisma } from '@/lib/db';
import { HttpError } from '@/lib/errors';
import {
  parseHandoff,
  parseStringList,
  parseTenantRules,
  type AuthContext,
  type TenantRules,
} from '@/lib/types';
import { requireCustomer } from '@/server/repositories/customers';
import { checkRuleGuards, type GuardViolation } from './guards';
import { applyHandoffPolicy } from './handoff';
import { parseLooseJson } from './json';
import { callDeepSeekJson, type LlmResult } from './llm';
import { buildAgentPrompt, HISTORY_LIMIT, PROMPT_VERSION, type PromptContext } from './prompt';
import { buildAgentOutputSchema, type AgentOutput } from './schema';
import { computeStageTransition, type StateAdjustment } from './state';

/**
 * AI Sales Agent 主干 pipeline。
 *
 * 一次调用的完整链路（README「AI Pipeline」章节讲的就是这里）：
 *
 *   ① 载入上下文（租户规则 + 交接规则 + 客户 + 旧状态 + 历史消息 + 本轮新消息）
 *   ② 组装 prompt（规则编号注入、交接标准注入、输出契约、安全边界）
 *   ③ 调 DeepSeek（json_object）→ 宽松解析 → zod 严格校验
 *   ④ 状态机裁决阶段（终态保护、不回退）
 *   ⑤ 规则守护：确定性校验回复是否违反企业红线
 *        违规 → 把违规原因回灌重写一次 → 仍违规 → 标记 + 强制转人工
 *   ⑥ 交接规则：按企业配置确定性决定"本轮是否需要人工"（敏感词、金额阈值、关闭的触发条件）
 *   ⑦ 事务落库：写 AiSuggestion（含原始请求/响应/token/成本/全部修正记录）+ 乐观锁更新 CustomerState
 *
 * 六个进阶钩子都挂在这条主干上（聚合窗口在入口、Follow-up 复用本函数）。
 */

export type AgentTrigger = 'NEW_MESSAGE' | 'REGENERATE' | 'FOLLOW_UP';

export type RunAgentInput = {
  ctx: AuthContext;
  customerId: string;
  /** 本轮要判断的客户消息（连续消息合并后可能多条） */
  messageIds?: string[];
  batchId?: string | null;
  trigger?: AgentTrigger;
  /** 销售点「深度重判」时用更强的模型 */
  useProModel?: boolean;
  /** 额外指令：人工指定的补充要求 */
  extraInstruction?: string;
  /** 试跑模式：只判断、不落库（用于"改规则前先看效果"的对照实验） */
  dryRun?: boolean;
  /** 试跑时注入一条"假设客户消息"（不落库），用于同一句话在新旧规则下的 A/B 对比 */
  dryRunMessage?: string;
  /** 试跑时用这套规则替换数据库里的规则（不写库） */
  ruleOverride?: {
    rules: TenantRules;
    handoff: ReturnType<typeof parseHandoff>;
    tone?: string;
    salesGoal?: string;
    forbidden?: string[];
  };
};

export type RunAgentResult = {
  suggestion: AiSuggestion | DraftSuggestion;
  adjustments: StateAdjustment[];
  state: {
    before: { leadStage: string; intent: string; needHuman: boolean; version: number };
    after: { leadStage: string; intent: string; needHuman: boolean; version: number };
  };
  status: SuggestionStatus;
  attempts: number;
  guardViolations: GuardViolation[];
  handoffNotes: string[];
  persisted: boolean;
};

/** 试跑模式返回的草稿（未落库，因此没有数据库生成的字段） */
export type DraftSuggestion = {
  id: string;
  customerIntent: string;
  intentDetail: string | null;
  leadStage: AgentOutput['lead_stage'];
  nextAction: string;
  reply: string;
  reason: string;
  needHuman: boolean;
  humanReason: string | null;
  rulesApplied: string[];
  ruleViolation: string | null;
  status: SuggestionStatus;
  model: string;
};

const MAX_ATTEMPTS = 2;
const BASE_MAX_TOKENS = 1024;
const MAX_TOKENS_CEILING = 4096;
/** 规则守护违规后允许的回灌重写次数 */
const MAX_GUARD_RETRIES = 1;

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const trigger: AgentTrigger = input.trigger ?? 'NEW_MESSAGE';
  const { ctx, customerId } = input;

  // ---------- ① 载入上下文（全部强制租户作用域） ----------
  const customer = await requireCustomer(ctx, customerId);

  const tenantRecord = await prisma.tenant.findUnique({ where: { id: ctx.tenantId } });
  if (!tenantRecord) throw new HttpError(404, '企业不存在');

  const currentState = customer.state ?? {
    leadStage: 'NEW' as const,
    intent: '待判断',
    needHuman: false,
    humanReason: null,
    followUpCount: 0,
    version: 0,
  };

  const tenantRules = input.ruleOverride?.rules ?? parseTenantRules(tenantRecord.rules);
  const handoffConfig = input.ruleOverride?.handoff ?? parseHandoff(tenantRecord.handoff);

  const newMessages = input.messageIds?.length
    ? await prisma.message.findMany({
        where: { tenantId: ctx.tenantId, customerId, id: { in: input.messageIds } },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  // 试跑注入的"假设客户消息"：参与判断与交接规则检测，但不写库
  const effectiveNewMessages: Array<{ role: 'CUSTOMER' | 'SALES'; content: string; createdAt: Date }> = [
    ...newMessages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    ...(input.dryRunMessage
      ? [{ role: 'CUSTOMER' as const, content: input.dryRunMessage, createdAt: new Date() }]
      : []),
  ];

  const historyRows = await prisma.message.findMany({
    where: {
      tenantId: ctx.tenantId,
      customerId,
      ...(newMessages.length > 0 ? { id: { notIn: newMessages.map((m) => m.id) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  });

  const basePromptContext: PromptContext = {
    tenant: {
      name: tenantRecord.name,
      salesGoal: input.ruleOverride?.salesGoal ?? tenantRecord.salesGoal,
      tone: input.ruleOverride?.tone ?? tenantRecord.tone,
      rules: tenantRules,
      forbidden: input.ruleOverride?.forbidden ?? parseStringList(tenantRecord.forbidden),
      handoff: handoffConfig,
    },
    customer: {
      name: customer.name,
      handle: customer.handle,
      source: customer.source,
      note: customer.note,
    },
    state: {
      leadStage: currentState.leadStage,
      intent: currentState.intent,
      needHuman: currentState.needHuman,
      humanReason: currentState.humanReason,
      followUpCount: currentState.followUpCount,
    },
    history: historyRows.reverse().map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
    newMessages: effectiveNewMessages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    trigger,
    extraInstruction: input.extraInstruction,
  };

  // ---------- ②③ 调用 + 校验（含规则守护回灌重试） ----------
  const model = input.useProModel ? env.deepseekModelPro : env.deepseekModel;
  let extraInstruction = input.extraInstruction;
  let outcome: ValidationOutcome | null = null;
  let stageTransition = computeStageTransition(
    { leadStage: currentState.leadStage, intent: currentState.intent },
    { lead_stage: currentState.leadStage } as AgentOutput,
  );
  let guardViolations: GuardViolation[] = [];
  let guardRetries = 0;

  for (;;) {
    const { system, user } = buildAgentPrompt({ ...basePromptContext, extraInstruction });

    outcome = await callWithValidation({
      system,
      user,
      model,
      label: `${trigger}:${customer.id.slice(0, 6)}${input.dryRun ? ':dry' : ''}`,
      fallbackStage: currentState.leadStage,
    });

    // ④ 状态机：阶段裁决（终态保护 / 不回退）
    stageTransition = computeStageTransition(
      { leadStage: currentState.leadStage, intent: currentState.intent },
      outcome.output,
    );

    // ⑤ 规则守护：确定性校验回复是否踩了企业红线
    guardViolations =
      outcome.status === 'FALLBACK'
        ? []
        : checkRuleGuards({
            rules: tenantRules,
            stage: stageTransition.next.leadStage,
            reply: outcome.output.reply,
            nextAction: outcome.output.next_action,
          });

    if (guardViolations.length > 0 && guardRetries < MAX_GUARD_RETRIES) {
      guardRetries += 1;
      extraInstruction = [
        input.extraInstruction,
        ...guardViolations.map((v) => `【违反企业规则 ${v.ruleId}】${v.instruction}`),
      ]
        .filter(Boolean)
        .join('\n');
      continue;
    }

    break;
  }

  if (!outcome) throw new Error('AI 调用未产生结果');

  // ---------- ⑥ 交接规则：本轮是否需要人工 ----------
  const handoff = applyHandoffPolicy({
    config: handoffConfig,
    customerMessages: effectiveNewMessages.filter((m) => m.role === 'CUSTOMER').map((m) => m.content),
    aiNeedHuman: outcome.output.need_human,
    aiHumanReason: outcome.output.human_reason ?? null,
    aiNextAction: outcome.output.next_action,
    guardViolations,
  });

  // 历史粘性：已标记需人工的客户，只有人工能解除（AI 与配置都不能自动清掉）
  const stickyNeedHuman = currentState.needHuman;
  const finalNeedHuman = stickyNeedHuman || handoff.needHuman;
  const finalHumanReason = handoff.needHuman
    ? handoff.humanReason
    : stickyNeedHuman
      ? currentState.humanReason
      : null;

  const adjustments: StateAdjustment[] = [...stageTransition.adjustments, ...handoff.adjustments];
  if (stickyNeedHuman && !handoff.needHuman) {
    adjustments.push({
      field: 'need_human',
      suggested: 'false',
      adopted: 'true',
      rule: 'HUMAN_FLAG_STICKY',
      note: '已标记需人工介入的客户，需人工处理完成后解除（AI 与企业规则都不会自动清除）',
    });
  }

  const ruleViolation = guardViolations.length > 0
    ? guardViolations.map((v) => `${v.ruleId}：${v.message}`).join('；')
    : null;

  const finalState = {
    leadStage: stageTransition.next.leadStage,
    intent: stageTransition.next.intent,
    needHuman: finalNeedHuman,
    humanReason: finalHumanReason,
  };

  // ---------- ⑦ 落库（或试跑直接返回草稿） ----------
  if (input.dryRun) {
    return {
      suggestion: {
        id: 'dry-run',
        customerIntent: outcome.output.customer_intent,
        intentDetail: outcome.output.intent_detail || null,
        leadStage: finalState.leadStage,
        nextAction: handoff.nextAction,
        reply: outcome.output.reply,
        reason: outcome.output.reason,
        needHuman: finalState.needHuman,
        humanReason: finalState.humanReason,
        rulesApplied: outcome.output.rules_applied,
        ruleViolation,
        status: outcome.status,
        model,
      },
      adjustments,
      state: {
        before: {
          leadStage: currentState.leadStage,
          intent: currentState.intent,
          needHuman: currentState.needHuman,
          version: currentState.version,
        },
        after: { ...finalState, version: currentState.version },
      },
      status: outcome.status,
      attempts: outcome.attempts,
      guardViolations,
      handoffNotes: handoff.notes,
      persisted: false,
    };
  }

  const persisted = await persistWithOptimisticLock({
    input,
    customerId,
    trigger,
    model,
    outcome,
    finalState,
    adjustments,
    handoffNotes: handoff.notes,
    ruleViolation,
    expectedVersion: currentState.version,
  });

  return {
    suggestion: persisted.suggestion,
    adjustments,
    state: {
      before: {
        leadStage: currentState.leadStage,
        intent: currentState.intent,
        needHuman: currentState.needHuman,
        version: currentState.version,
      },
      after: {
        leadStage: persisted.state.leadStage,
        intent: persisted.state.intent,
        needHuman: persisted.state.needHuman,
        version: persisted.state.version,
      },
    },
    status: outcome.status,
    attempts: outcome.attempts,
    guardViolations,
    handoffNotes: handoff.notes,
    persisted: true,
  };
}

// ---------------------------------------------------------------------------
// 调用 + 解析 + 结构校验
// ---------------------------------------------------------------------------

type ValidationOutcome = {
  output: AgentOutput;
  llm: LlmResult | null;
  status: SuggestionStatus;
  attempts: number;
  errors: string[];
};

async function callWithValidation(params: {
  system: string;
  user: string;
  model: string;
  label: string;
  fallbackStage: AgentOutput['lead_stage'];
}): Promise<ValidationOutcome> {
  const schema = buildAgentOutputSchema(params.fallbackStage);
  const errors: string[] = [];

  let userPrompt = params.user;
  let maxTokens = BASE_MAX_TOKENS;
  let lastResult: LlmResult | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    lastResult = await callDeepSeekJson({
      system: params.system,
      user: userPrompt,
      model: params.model,
      maxTokens,
      temperature: 0.3,
      label: `${params.label}#${attempt}`,
    });

    if (!lastResult.ok) {
      errors.push(`${lastResult.errorKind}: ${lastResult.errorMessage}`);
      if (lastResult.errorKind === 'truncated') {
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
      }
      continue;
    }

    const raw = parseLooseJson(lastResult.content ?? '');
    if (raw === undefined) {
      errors.push('bad_json: 模型输出不是合法 JSON');
      userPrompt = `${params.user}\n\n【上一次的输出不是合法 json，请只输出一个 json 对象，不要任何解释文字。】`;
      continue;
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('；');
      errors.push(`schema: ${detail}`);
      userPrompt = `${params.user}\n\n【上一次的 json 不符合要求：${detail}。请重新输出一个完全符合字段要求的 json。】`;
      continue;
    }

    return {
      output: parsed.data,
      llm: lastResult,
      status: attempt === 1 ? 'SUCCESS' : 'RETRY_OK',
      attempts: attempt,
      errors,
    };
  }

  return {
    output: buildFallbackOutput(errors, params.fallbackStage),
    llm: lastResult,
    status: 'FALLBACK',
    attempts: MAX_ATTEMPTS,
    errors,
  };
}

function buildFallbackOutput(errors: string[], stage: AgentOutput['lead_stage']): AgentOutput {
  const last = errors.at(-1) ?? '未知错误';
  return {
    customer_intent: '其他',
    intent_detail: 'AI 判断失败',
    lead_stage: stage,
    next_action: '转人工',
    reply: '您好，我看到您的消息了，稍后会有同事给您详细回复，请稍等。',
    reason: `AI 调用异常（${last}），系统已降级为人工跟进，请销售直接接手。`,
    need_human: true,
    human_reason: 'AI 输出异常降级',
    rules_applied: [],
  };
}

// ---------------------------------------------------------------------------
// 落库：乐观锁 + 冲突重试
// ---------------------------------------------------------------------------

async function persistWithOptimisticLock(params: {
  input: RunAgentInput;
  customerId: string;
  trigger: AgentTrigger;
  model: string;
  outcome: ValidationOutcome;
  finalState: { leadStage: AgentOutput['lead_stage']; intent: string; needHuman: boolean; humanReason: string | null };
  adjustments: StateAdjustment[];
  handoffNotes: string[];
  ruleViolation: string | null;
  expectedVersion: number;
}): Promise<{ suggestion: AiSuggestion; state: { leadStage: string; intent: string; needHuman: boolean; version: number } }> {
  const { ctx } = params.input;
  let expectedVersion = params.expectedVersion;

  for (let round = 0; round < 3; round += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const suggestion = await tx.aiSuggestion.create({
          data: {
            tenantId: ctx.tenantId,
            customerId: params.customerId,
            batchId: params.input.batchId ?? null,
            customerIntent: params.outcome.output.customer_intent,
            intentDetail: params.outcome.output.intent_detail || null,
            leadStage: params.finalState.leadStage,
            nextAction: params.outcome.output.next_action,
            reply: params.outcome.output.reply,
            reason: params.outcome.output.reason,
            needHuman: params.finalState.needHuman,
            humanReason: params.finalState.humanReason,
            rulesApplied: params.outcome.output.rules_applied as unknown as Prisma.InputJsonValue,
            trigger: params.trigger,
            stateAdjustments: params.adjustments.length
              ? (params.adjustments as unknown as Prisma.InputJsonValue)
              : undefined,
            handoffNotes: params.handoffNotes.length
              ? (params.handoffNotes as unknown as Prisma.InputJsonValue)
              : undefined,
            ruleViolation: params.ruleViolation,
            status: params.outcome.status,
            model: params.model,
            promptVersion: PROMPT_VERSION,
            rawRequest: (params.outcome.llm?.rawRequest ?? null) as unknown as Prisma.InputJsonValue,
            rawResponse: (params.outcome.llm?.rawResponse ?? null) as unknown as Prisma.InputJsonValue,
            latencyMs: params.outcome.llm?.latencyMs ?? null,
            promptTokens: params.outcome.llm?.usage.promptTokens ?? null,
            completionTokens: params.outcome.llm?.usage.completionTokens ?? null,
            estimatedCostCny: params.outcome.llm
              ? estimateCostCny(
                  params.outcome.llm.usage.promptTokens,
                  params.outcome.llm.usage.completionTokens,
                )
              : null,
            retryCount: Math.max(0, params.outcome.attempts - 1),
            errorMessage: params.outcome.errors.length > 0 ? params.outcome.errors.join(' | ') : null,
          },
        });

        const updated = await tx.customerState.updateMany({
          where: { customerId: params.customerId, version: expectedVersion },
          data: {
            leadStage: params.finalState.leadStage,
            intent: params.finalState.intent,
            needHuman: params.finalState.needHuman,
            humanReason: params.finalState.humanReason,
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) throw new StateVersionConflict();

        const state = await tx.customerState.findUniqueOrThrow({
          where: { customerId: params.customerId },
          select: { leadStage: true, intent: true, needHuman: true, version: true },
        });

        return { suggestion, state };
      });
    } catch (error) {
      if (error instanceof StateVersionConflict && round < 2) {
        const fresh = await prisma.customerState.findUnique({
          where: { customerId: params.customerId },
          select: { version: true },
        });
        console.warn(
          `[agent] 状态版本冲突，重试第 ${round + 1} 次（期望 v${expectedVersion} → 实际 v${fresh?.version}）`,
        );
        expectedVersion = fresh?.version ?? expectedVersion;
        continue;
      }
      throw error;
    }
  }

  throw new Error('状态更新持续冲突，已放弃本次落库');
}

class StateVersionConflict extends Error {
  constructor() {
    super('CustomerState 版本冲突');
  }
}
