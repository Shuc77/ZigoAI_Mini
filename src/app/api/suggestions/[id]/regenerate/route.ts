import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAgent } from '@/lib/agent/pipeline';
import { notFound, unauthorized } from '@/lib/errors';
import { prisma } from '@/lib/db';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';

export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  /** true 时使用更强的模型（deepseek-v4-pro）重新判断，用于对比质量与成本 */
  useProModel: z.boolean().optional(),
});

/**
 * 重新生成建议（不产生新的客户消息）。
 *
 * 两个用途：
 *  1) 销售对当前建议不满意，想换个角度；
 *  2) 演示"模型质量 vs 成本"的取舍 —— 用 deepseek-v4-pro 重判一次，AI 日志页能直接对比耗时与 token。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const { id } = await params;
    const parsed = bodySchema.safeParse(await readJson(request).catch(() => ({})));
    const useProModel = parsed.success ? (parsed.data.useProModel ?? false) : false;

    const suggestion = await prisma.aiSuggestion.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: { customerId: true },
    });
    if (!suggestion) throw notFound('AI 建议');

    const agent = await runAgent({
      ctx,
      customerId: suggestion.customerId,
      trigger: 'REGENERATE',
      useProModel,
    });

    return NextResponse.json({ suggestion: agent.suggestion, state: agent.state, status: agent.status });
  } catch (error) {
    return jsonError(error, 'suggestions:regenerate');
  }
}
