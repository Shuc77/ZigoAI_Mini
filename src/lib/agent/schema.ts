import { z } from 'zod';
import type { LeadStage } from '@/generated/prisma/enums';
import {
  CUSTOMER_INTENTS,
  HUMAN_REASONS,
  LEAD_STAGES,
  NEXT_ACTIONS,
} from '@/lib/types';

/**
 * AI 结构化输出的**唯一定义**。
 *
 * 一份 schema 三处复用（这是本项目刻意做的设计）：
 *   1) 生成 prompt 里的字段说明与 JSON 示例 —— 保证"模型看到的格式"与"我们要校验的格式"永远一致
 *   2) 运行时校验模型输出 —— 不合规就重试或降级，而不是把脏数据写进库
 *   3) TypeScript 类型推导 —— 下游代码全部类型安全
 *
 * 关于 `.catch()` 的取舍（答辩点）：
 *   枚举类字段（意图/阶段/动作/是否转人工）用 `.catch()` 兜底，因为这些是最容易被模型"换个说法"
 *   而漂移的字段，为它们整批失败不划算；而 `reply` / `reason` 属于核心产出，**宁可重试也不将就**，
 *   所以不加 catch，缺失即触发重试/降级流程。
 */
export function buildAgentOutputSchema(currentStage: LeadStage) {
  return z.object({
    customer_intent: z.enum(CUSTOMER_INTENTS).catch('其他'),
    intent_detail: z.string().max(60).catch(''),
    lead_stage: z.enum(LEAD_STAGES).catch(currentStage),
    next_action: z.enum(NEXT_ACTIONS).catch('转人工'),
    reply: z.string().trim().min(1).max(800),
    reason: z.string().trim().min(1).max(500),
    need_human: z.boolean().catch(true),
    human_reason: z.enum(HUMAN_REASONS).nullish().catch(null),
    /** AI 自述本次判断引用了哪几条企业规则（规则编号），用于证明"规则真的影响了判断" */
    rules_applied: z.array(z.string().max(10)).max(6).catch([]),
  });
}

export type AgentOutput = z.infer<ReturnType<typeof buildAgentOutputSchema>>;

/**
 * 交给模型的 JSON 示例（写在 prompt 里）。
 * DeepSeek 官方要求：JSON 模式必须在提示词中出现 "json" 字样并给出示例。
 */
export const AGENT_OUTPUT_EXAMPLE = {
  customer_intent: '询价',
  intent_detail: '询问单节课价格与体验课',
  lead_stage: 'INTERESTED',
  next_action: '推进体验',
  reply: '价格我按孩子年龄和班型给您算，先约一节体验课试试？周六上午 10 点或周日下午 4 点都还有位。',
  reason: '客户主动询问价格并提到体验课，属于明确意向；按企业规则 R1 此时可以报价，但优先动作是推动到店体验。',
  need_human: false,
  human_reason: null,
  rules_applied: ['R1', 'R2'],
};
