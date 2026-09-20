import type { Prisma } from '@/generated/prisma/client';
import type { AiSuggestion, SuggestionStatus } from '@/generated/prisma/client';
import { estimateCostCny, env } from '@/lib/env';
import { prisma } from '@/lib/db';
import { HttpError } from '@/lib/errors';
import { parseStringList, parseTenantRules, type AuthContext } from '@/lib/types';
import { requireCustomer } from '@/server/repositories/customers';
import { parseLooseJson } from './json';
import { callDeepSeekJson, type LlmResult } from './llm';
import { buildAgentPrompt, HISTORY_LIMIT, PROMPT_VERSION, type PromptContext } from './prompt';
import { buildAgentOutputSchema, type AgentOutput } from './schema';
import { computeStateTransition, type StateAdjustment } from './state';

/**
 * AI Sales Agent 主干 pipeline。
 *
 * 一次调用的完整链路（这也是 README「AI Pipeline」那一节要讲的东西）：
 *
 *   载入上下文（租户规则 + 客户 + 旧状态 + 历史消息 + 本轮新消息）
 *     → 组装 prompt
 *     → 调 DeepSeek（json_object）
 *     → 宽松解析 + zod 严格校验
 *     → 不合格就带着错误信息重试一次（预算不足则加大预算）
 *     → 仍不合格 → 降级为"转人工"的兜底建议（**绝不把脏数据写库，也绝不让页面崩**）
 *     → 状态机裁决（AI 建议 vs 系统采纳）
 *     → 事务落库：写 AiSuggestion（含原始请求/响应/token/成本）+ 乐观锁更新 CustomerState
 *
 * 六个进阶钩子都挂在这条主干上（聚合窗口在入口、规则守护在校验之后、Follow-up 复用本函数）。
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
  /** 额外指令：规则守护发现违规后的重写要求 */
  extraInstruction?: string;
};

export type RunAgentResult = {
  suggestion: AiSuggestion;
  adjustments: StateAdjustment[];
  state: {
    before: { leadStage: string; intent: string; needHuman: boolean; version: number };
    after: { leadStage: string; intent: string; needHuman: boolean; version: number };
  };
  status: SuggestionStatus;
  attempts: number;
};

const MAX_ATTEMPTS = 2;
const BASE_MAX_TOKENS = 1024;
/** 截断时翻倍预算的上限，防止异常情况下烧钱 */
const MAX_TOKENS_CEILING = 4096;

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const trigger: AgentTrigger = input.trigger ?? 'NEW_MESSAGE';
  const { ctx, customerId } = input;

  // ---------- 1) 载入上下文（全部强制租户作用域） ----------
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

  const newMessages = input.messageIds?.length
    ? await prisma.message.findMany({
        where: { tenantId: ctx.tenantId, customerId, id: { in: input.messageIds } },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  const historyRows = await prisma.message.findMany({
    where: {
      tenantId: ctx.tenantId,
      customerId,
      ...(newMessages.length > 0 ? { id: { notIn: newMessages.map((m) => m.id) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  });

  const promptContext: PromptContext = {
    tenant: {
      name: tenantRecord.name,
      salesGoal: tenantRecord.salesGoal,
      tone: tenantRecord.tone,
      rules: parseTenantRules(tenantRecord.rules),
      forbidden: parseStringList(tenantRecord.forbidden),
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
    newMessages: newMessages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    trigger,
    extraInstruction: input.extraInstruction,
  };

  const { system, user } = buildAgentPrompt(promptContext);

  // ---------- 2) 调用 + 校验 + 重试 + 降级 ----------
  const model = input.useProModel ? env.deepseekModelPro : env.deepseekModel;
  const outcome = await callWithValidation({
    system,
    user,
    model,
    label: `${trigger}:${customer.id.slice(0, 6)}`,
    fallbackStage: currentState.leadStage,
  });

  // ---------- 3) 状态机裁决 ----------
  const transition = computeStateTransition(
    {
      leadStage: currentState.leadStage,
      intent: currentState.intent,
      needHuman: currentState.needHuman,
      humanReason: currentState.humanReason,
    },
    outcome.output,
  );

  // ---------- 4) 事务落库（建议 + 状态，带乐观锁重试） ----------
  const persisted = await persistWithOptimisticLock({
    input,
    customerId,
    trigger,
    model,
    outcome,
    transition: transition.next,
    adjustments: transition.adjustments,
    expectedVersion: currentState.version,
    stateBefore: currentState,
  });

  return {
    suggestion: persisted.suggestion,
    adjustments: transition.adjustments,
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
  };
}

// ---------------------------------------------------------------------------
// 调用 + 校验 + 重试
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

    // (a) 调用层失败：区分"预算不足被截断"与其它错误
    if (!lastResult.ok) {
      errors.push(`${lastResult.errorKind}: ${lastResult.errorMessage}`);
      if (lastResult.errorKind === 'truncated') {
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
      }
      continue;
    }

    // (b) 解析失败（模型没吐 JSON）
    const raw = parseLooseJson(lastResult.content ?? '');
    if (raw === undefined) {
      errors.push('bad_json: 模型输出不是合法 JSON');
      userPrompt = `${params.user}\n\n【上一次的输出不是合法 json，请只输出一个 json 对象，不要任何解释文字。】`;
      continue;
    }

    // (c) 结构校验失败：把错误回灌给模型再试一次
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

  // (d) 全部尝试失败 → 降级为"转人工"的兜底建议，保证业务不中断
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
  transition: { leadStage: AgentOutput['lead_stage']; intent: string; needHuman: boolean; humanReason: string | null };
  adjustments: StateAdjustment[];
  expectedVersion: number;
  stateBefore: { leadStage: string; intent: string; needHuman: boolean; version: number };
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
            leadStage: params.transition.leadStage,
            nextAction: params.outcome.output.next_action,
            reply: params.outcome.output.reply,
            reason: params.outcome.output.reason,
            needHuman: params.transition.needHuman,
            humanReason: params.transition.humanReason,
            rulesApplied: params.outcome.output.rules_applied as unknown as Prisma.InputJsonValue,
            trigger: params.trigger,
            stateAdjustments: params.adjustments.length
              ? (params.adjustments as unknown as Prisma.InputJsonValue)
              : undefined,
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

        // 乐观锁：只有版本号仍然是读到的那个值时才更新，避免并发判断互相覆盖
        const updated = await tx.customerState.updateMany({
          where: { customerId: params.customerId, version: expectedVersion },
          data: {
            leadStage: params.transition.leadStage,
            intent: params.transition.intent,
            needHuman: params.transition.needHuman,
            humanReason: params.transition.humanReason,
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new StateVersionConflict();
        }

        const state = await tx.customerState.findUniqueOrThrow({
          where: { customerId: params.customerId },
          select: { leadStage: true, intent: true, needHuman: true, version: true },
        });

        return { suggestion, state };
      });
    } catch (error) {
      if (error instanceof StateVersionConflict && round < 2) {
        // 并发更新：重新读取版本号后重试（事务已回滚，不会产生重复建议）
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
