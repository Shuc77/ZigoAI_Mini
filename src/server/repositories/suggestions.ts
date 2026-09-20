import { prisma } from '@/lib/db';
import type { AuthContext } from '@/lib/types';
import { requireCustomer } from '@/server/repositories/customers';

/**
 * AI 建议仓储层。
 * 建议天然属于客户，而客户已经过租户作用域校验，因此这里的查询同样带上 tenantId 双保险。
 */

export async function getLatestSuggestion(ctx: AuthContext, customerId: string) {
  await requireCustomer(ctx, customerId);

  return prisma.aiSuggestion.findFirst({
    where: { tenantId: ctx.tenantId, customerId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listSuggestions(ctx: AuthContext, customerId: string, limit = 10) {
  await requireCustomer(ctx, customerId);

  return prisma.aiSuggestion.findMany({
    where: { tenantId: ctx.tenantId, customerId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** AI 调用审计列表（AI 日志页用）：本企业最近若干次调用 */
export async function listRecentAiCalls(ctx: AuthContext, limit = 50) {
  return prisma.aiSuggestion.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      customerId: true,
      customerIntent: true,
      leadStage: true,
      nextAction: true,
      needHuman: true,
      status: true,
      model: true,
      promptVersion: true,
      trigger: true,
      latencyMs: true,
      promptTokens: true,
      completionTokens: true,
      estimatedCostCny: true,
      retryCount: true,
      errorMessage: true,
      ruleViolation: true,
      createdAt: true,
      customer: { select: { name: true } },
    },
  });
}

/** 本企业 AI 调用成本汇总（用于 AI 日志页与 README 的 AI 成本一栏） */
export async function summarizeAiCost(ctx: AuthContext) {
  const aggregate = await prisma.aiSuggestion.aggregate({
    where: { tenantId: ctx.tenantId },
    _count: { _all: true },
    _sum: { promptTokens: true, completionTokens: true, estimatedCostCny: true },
  });

  const fallbackCount = await prisma.aiSuggestion.count({
    where: { tenantId: ctx.tenantId, status: { in: ['FALLBACK', 'ERROR'] } },
  });

  return {
    calls: aggregate._count._all,
    promptTokens: aggregate._sum.promptTokens ?? 0,
    completionTokens: aggregate._sum.completionTokens ?? 0,
    estimatedCostCny: aggregate._sum.estimatedCostCny ?? 0,
    fallbackCount,
  };
}

/**
 * AI 建议的采纳情况 —— **回答"AI 到底有没有帮上忙"**。
 *
 * 判据来自 M3 埋的留痕字段：
 *   - 已发送且 finalReply === reply  → 按 AI 原文发出（采纳）
 *   - 已发送且 finalReply !== reply  → 销售改过（修改）
 * 修改率越高，说明建议越不贴业务，应该回头补规则、补示例。
 */
export async function summarizeAdoption(ctx: AuthContext) {
  // 采纳判定要比较两列（reply 与 finalReply），这里在应用层做，避免依赖数据库的字段引用能力
  const [total, sentRows, needHuman, ruleViolations] = await Promise.all([
    prisma.aiSuggestion.count({ where: { tenantId: ctx.tenantId } }),
    prisma.aiSuggestion.findMany({
      where: { tenantId: ctx.tenantId, sentMessageId: { not: null } },
      select: { reply: true, finalReply: true },
    }),
    prisma.aiSuggestion.count({ where: { tenantId: ctx.tenantId, needHuman: true } }),
    prisma.aiSuggestion.count({ where: { tenantId: ctx.tenantId, ruleViolation: { not: null } } }),
  ]);

  const sent = sentRows.length;
  const acceptedUnchanged = sentRows.filter((row) => row.finalReply === row.reply).length;
  const modified = sent - acceptedUnchanged;

  return {
    total,
    sent,
    acceptedUnchanged,
    modified,
    needHuman,
    ruleViolations,
    /** 已发送的建议里，AI 原文被直接采纳的比例 */
    acceptanceRate: sent > 0 ? acceptedUnchanged / sent : 0,
    modificationRate: sent > 0 ? modified / sent : 0,
  };
}
