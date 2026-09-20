import type { NextAction, HandoffConfig } from '@/lib/types';
import type { StateAdjustment } from './state';
import type { GuardViolation } from './guards';

/**
 * 交接规则（handoff）的**运行时执行**。
 *
 * 与 prompt 的分工：prompt 负责"告诉模型本企业的转人工标准"（引导），
 * 本文件负责"按企业配置确定性地决定这一轮是否需要人工"（约束）。
 * 只有后者才有牙齿 —— 模型可能忽略提示词，但代码不会。
 *
 * 两条关键设计（答辩要点）：
 *
 * 1) **规则守护违规与敏感词必定升级**：这是企业自己划的红线，不经模型判断，直接置为需人工。
 *    金额阈值同理（高客单行业"保费 3000 元"必须人工核保，快消行业则不必）。
 *
 * 2) **企业配置可以关闭某一类转人工，但 AI 不能自行解除**。
 *    两者的区别在于"谁在解除"：前者是人写下来、可审计、可回滚的企业规则；
 *    后者是模型在某一轮对话里的临场判断。所以：
 *      - 企业配置关掉"投诉必转人工" → 本轮建议可以不转人工（并记录一条修正说明）；
 *      - 与此同时 CustomerState.needHuman 仍然是"只升不降"，历史标记只有人工能解除。
 *    这样"每一轮的建议"与"客户当前状态"各归其位，既不失控也不僵硬。
 *
 * 3) **系统兜底不可关闭**：AI 调用异常导致的降级（human_reason = AI 输出异常降级）
 *    永远转人工，任何企业配置都不能把它关掉 —— 否则 AI 挂了还没人管。
 */

const REASON_TO_TRIGGER: Record<string, keyof HandoffConfig['triggers'] | 'ALWAYS'> = {
  客户投诉: 'complaint',
  客户明确要求真人: 'wantsHuman',
  'AI 无法确认答案': 'aiUnsure',
  高价值成交信号: 'highValue',
  触发租户规则红线: 'ruleConflict',
  'AI 输出异常降级': 'ALWAYS',
  其他: 'ALWAYS',
};

/** 因企业配置关闭转人工时，把"转人工"这个动作替换成合理的替代动作 */
const DOWNGRADE_ACTION: Record<string, NextAction> = {
  客户投诉: '处理异议',
  客户明确要求真人: '回答问题',
  'AI 无法确认答案': '回答问题',
  高价值成交信号: '确认需求',
  触发租户规则红线: '回答问题',
};

export type HandoffOutcome = {
  needHuman: boolean;
  humanReason: string | null;
  nextAction: NextAction;
  /** 触发/解除说明，写入日志便于排障 */
  notes: string[];
  adjustments: StateAdjustment[];
};

export function applyHandoffPolicy(params: {
  config: HandoffConfig;
  /** 本轮客户消息文本（用于敏感词与金额检测） */
  customerMessages: string[];
  aiNeedHuman: boolean;
  aiHumanReason: string | null;
  aiNextAction: NextAction;
  guardViolations: GuardViolation[];
}): HandoffOutcome {
  const { config } = params;
  const notes: string[] = [];
  const adjustments: StateAdjustment[] = [];

  let needHuman = params.aiNeedHuman;
  let humanReason = params.aiHumanReason;
  let nextAction = params.aiNextAction;

  // ---- 1) 规则守护违规：企业红线，直接升级 --------------------------------
  if (params.guardViolations.length > 0 && config.triggers.ruleConflict) {
    needHuman = true;
    humanReason = '触发租户规则红线';
    notes.push(
      `规则守护发现 ${params.guardViolations.length} 处违规：${params.guardViolations
        .map((v) => `${v.ruleId} ${v.message}`)
        .join('；')}`,
    );
  }

  // ---- 2) 敏感词：命中即升级 ----------------------------------------------
  const hitKeyword = config.keywords.find((keyword) =>
    params.customerMessages.some((message) => message.includes(keyword)),
  );
  if (hitKeyword) {
    needHuman = true;
    humanReason = '触发租户规则红线';
    notes.push(`客户消息命中企业敏感词「${hitKeyword}」，按交接规则转人工`);
  }

  // ---- 3) 金额阈值 --------------------------------------------------------
  if (config.amountThreshold !== null) {
    const amount = extractMaxAmount(params.customerMessages);
    if (amount !== null && amount >= config.amountThreshold) {
      needHuman = true;
      humanReason = humanReason ?? '高价值成交信号';
      notes.push(`对话涉及金额约 ${amount} 元，达到企业阈值 ${config.amountThreshold} 元，按交接规则转人工`);
    }
  }

  // ---- 4) 企业配置关闭某一类转人工（唯一能"降级"的路径，且必须记录） ------
  if (params.aiNeedHuman && params.aiHumanReason) {
    const triggerKey = REASON_TO_TRIGGER[params.aiHumanReason];
    const enabled = triggerKey === 'ALWAYS' || triggerKey === undefined ? true : config.triggers[triggerKey];

    if (!enabled) {
      // 注意：只有在"没有其它升级理由"时才真正降级
      const escalatedByPolicy = Boolean(hitKeyword) || params.guardViolations.length > 0;
      if (!escalatedByPolicy) {
        needHuman = false;
        humanReason = null;

        const replacement = DOWNGRADE_ACTION[params.aiHumanReason];
        if (replacement && nextAction === '转人工') {
          nextAction = replacement;
        }

        adjustments.push({
          field: 'need_human',
          suggested: 'true',
          adopted: 'false',
          rule: 'HANDOFF_POLICY_DISABLED',
          note: `AI 建议因「${params.aiHumanReason}」转人工，但本企业交接规则未启用该情形，故本轮不升级${
            replacement && params.aiNextAction === '转人工' ? `（动作改为「${replacement}」）` : ''
          }`,
        });
        notes.push(`企业交接规则未启用「${params.aiHumanReason}」，本轮建议不转人工`);
      }
    }
  }

  // ---- 5) 最终升级：记录成可展示的修正 ------------------------------------
  if (needHuman && !params.aiNeedHuman) {
    adjustments.push({
      field: 'need_human',
      suggested: 'false',
      adopted: 'true',
      rule: 'HANDOFF_POLICY_ESCALATION',
      note: `按企业交接规则升级为人工介入：${notes.at(-1) ?? humanReason ?? '达到转人工条件'}`,
    });
  }

  return { needHuman, humanReason: needHuman ? (humanReason ?? '其他') : null, nextAction, notes, adjustments };
}

/** 从客户消息中提取最大金额（支持"3 万""5000 元""1500 块"） */
export function extractMaxAmount(messages: string[]): number | null {
  let max: number | null = null;
  const pattern = /(\d+(?:\.\d+)?)\s*(万|元|块)/g;

  for (const message of messages) {
    for (const match of message.matchAll(pattern)) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) continue;
      const amount = match[2] === '万' ? value * 10_000 : value;
      if (max === null || amount > max) max = amount;
    }
  }

  return max;
}
