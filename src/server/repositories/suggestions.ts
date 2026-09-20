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

/** 本企业 AI 调用成本汇总（用于 README 的 AI 成本一栏） */
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
