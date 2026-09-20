/**
 * 领域类型与枚举字典（客户端/服务端共享，禁止 import env 或 db）。
 *
 * 为什么枚举值用中文字符串：这些值会直接进入 prompt、也会直接展示给销售看。
 * 用中文可以避免"枚举值再翻译一遍"造成的语义漂移，也便于在 AI 日志页里肉眼比对。
 */
import type { LeadStage, Role } from '@/generated/prisma/enums';

// ---------------------------------------------------------------------------
// 客户意图（customer_intent）
// ---------------------------------------------------------------------------
export const CUSTOMER_INTENTS = [
  '了解产品',
  '询价',
  '预约',
  '犹豫',
  '投诉',
  '购买',
  '售后',
  '其他',
] as const;
export type CustomerIntent = (typeof CUSTOMER_INTENTS)[number];

// ---------------------------------------------------------------------------
// 销售阶段（lead_stage）
// 设计理由：映射真实销售漏斗，且**顺序化**（STAGE_ORDER），这样"阶段只能前进、
// 终态需要人工确认"才能写成可测试的规则，而不是靠模型自觉。
// ---------------------------------------------------------------------------
export const LEAD_STAGES = [
  'NEW',
  'DISCOVERY',
  'INTERESTED',
  'HIGH_INTENT',
  'WON',
  'LOST',
] as const satisfies readonly LeadStage[];

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  NEW: '新客户',
  DISCOVERY: '探需中',
  INTERESTED: '有意向',
  HIGH_INTENT: '高意向',
  WON: '已成交',
  LOST: '已流失',
};

export const STAGE_ORDER: Record<LeadStage, number> = {
  NEW: 0,
  DISCOVERY: 1,
  INTERESTED: 2,
  HIGH_INTENT: 3,
  WON: 4,
  LOST: 4,
};

/** 终态：一旦成交/流失，AI 不允许自动改动，必须人工确认 */
export const TERMINAL_STAGES: readonly LeadStage[] = ['WON', 'LOST'];

// ---------------------------------------------------------------------------
// 下一步动作（next_action）
// ---------------------------------------------------------------------------
export const NEXT_ACTIONS = [
  '继续探需',
  '回答问题',
  '推进体验',
  '确认需求',
  '索取资料',
  '报价',
  '处理异议',
  '转人工',
  '暂不处理',
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// 建议人工介入的原因（need_human 的配套字段）
// ---------------------------------------------------------------------------
export const HUMAN_REASONS = [
  '客户投诉',
  '客户明确要求真人',
  'AI 无法确认答案',
  '高价值成交信号',
  '触发租户规则红线',
  'AI 输出异常降级',
  '其他',
] as const;
export type HumanReason = (typeof HUMAN_REASONS)[number];

// ---------------------------------------------------------------------------
// 鉴权上下文：所有仓储函数都必须接收它，这是多租户隔离的第一道约束
// ---------------------------------------------------------------------------
export type AuthContext = {
  userId: string;
  userName: string;
  email: string;
  role: Role;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
};

export function isManager(ctx: AuthContext): boolean {
  return ctx.role === 'MANAGER';
}

// ---------------------------------------------------------------------------
// 租户规则结构（存 Tenant.rules 的 JSON）
// guard 是可选的**机器可校验**规则码：模型不遵守时由代码兜底，而不是只靠 prompt 祈祷
// ---------------------------------------------------------------------------
export const RULE_GUARDS = [
  'FORBID_QUOTE_BEFORE_INTEREST',
  'FORBID_ABSOLUTE_PROMISE',
  'REQUIRE_DOC_REQUEST_ON_DEVICE_INTENT',
] as const;
export type RuleGuard = (typeof RULE_GUARDS)[number];

export type TenantRule = {
  id: string;
  text: string;
  guard?: RuleGuard;
};

export type TenantRules = TenantRule[];

/**
 * 从数据库的 Json 字段安全解析租户规则。
 * 数据库里是 unknown，直接当 TenantRules 用会在运行时炸；这里做一次收口校验。
 */
export function parseTenantRules(value: unknown): TenantRules {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    const text = typeof record.text === 'string' ? record.text : null;
    if (!id || !text) return [];
    const guard = RULE_GUARDS.includes(record.guard as RuleGuard)
      ? (record.guard as RuleGuard)
      : undefined;
    return [{ id, text, guard }];
  });
}

/** 从数据库的 Json 字段解析"禁止事项"列表 */
export function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

// ---------------------------------------------------------------------------
// 交接规则（handoff）：什么情况必须交给人
//
// 早期版本把"投诉/要求真人/AI 不确定/高价值/规则红线"硬编码在 prompt 与状态机里，
// 但不同企业的转人工标准必然不同（高客单行业"问价"就该转人工，快消行业"问价"是日常），
// 因此它必须成为企业级配置。
// ---------------------------------------------------------------------------
export type HandoffTriggers = {
  /** 客户投诉或情绪明显不满 */
  complaint: boolean;
  /** 客户明确要求真人 / 要求电话沟通 */
  wantsHuman: boolean;
  /** AI 无法确认答案，或涉及企业未给出的政策 */
  aiUnsure: boolean;
  /** 出现明确成交信号（要签约、付款、发票） */
  highValue: boolean;
  /** 触发企业规则红线（规则守护判定违规） */
  ruleConflict: boolean;
};

export type HandoffConfig = {
  triggers: HandoffTriggers;
  /** 命中即转人工的敏感词（行业差异极大，例如保险的"起诉/监管"、教培的"退费/曝光"） */
  keywords: string[];
  /** 涉及金额达到该阈值（元）即转人工；null 表示不按金额判断 */
  amountThreshold: number | null;
  /** 给模型看的一句话说明 */
  note: string;
};

export const DEFAULT_HANDOFF: HandoffConfig = {
  triggers: {
    complaint: true,
    wantsHuman: true,
    aiUnsure: true,
    highValue: true,
    ruleConflict: true,
  },
  keywords: [],
  amountThreshold: null,
  note: '',
};

export function parseHandoff(value: unknown): HandoffConfig {
  if (typeof value !== 'object' || value === null) return DEFAULT_HANDOFF;
  const record = value as Record<string, unknown>;
  const triggersRecord =
    typeof record.triggers === 'object' && record.triggers !== null
      ? (record.triggers as Record<string, unknown>)
      : {};

  const bool = (key: keyof HandoffTriggers): boolean =>
    typeof triggersRecord[key] === 'boolean'
      ? (triggersRecord[key] as boolean)
      : DEFAULT_HANDOFF.triggers[key];

  return {
    triggers: {
      complaint: bool('complaint'),
      wantsHuman: bool('wantsHuman'),
      aiUnsure: bool('aiUnsure'),
      highValue: bool('highValue'),
      ruleConflict: bool('ruleConflict'),
    },
    keywords: parseStringList(record.keywords),
    amountThreshold:
      typeof record.amountThreshold === 'number' && Number.isFinite(record.amountThreshold)
        ? record.amountThreshold
        : null,
    note: typeof record.note === 'string' ? record.note : '',
  };
}
