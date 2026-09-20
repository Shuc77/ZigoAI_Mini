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
  'REQUIRE_DOC_REQUEST_ON_DEVICE_INTENT',
] as const;
export type RuleGuard = (typeof RULE_GUARDS)[number];

export type TenantRule = {
  id: string;
  text: string;
  guard?: RuleGuard;
};

export type TenantRules = TenantRule[];
