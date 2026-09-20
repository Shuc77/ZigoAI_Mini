import { NextResponse } from 'next/server';
import { countBatchMessages } from '@/lib/agent/batch';
import { unauthorized } from '@/lib/errors';
import { prisma } from '@/lib/db';
import { getApiAuth } from '@/server/auth';
import { jsonError } from '@/server/api';
import { getLatestSuggestion } from '@/server/repositories/suggestions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 查询某个批次的 AI 判断是否已生成。
 *
 * 为什么需要它：引入连续消息合并后，发消息接口不再同步返回建议（要先等聚合窗口关闭），
 * 前端需要轮询"这一批判断好了没有"。同时返回该批次包含多少条客户消息，
 * 便于界面显示"本轮合并了 3 条消息"—— 这是把"合并"这件事变成**可见证据**的关键。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const { id } = await params;
    const batchId = new URL(request.url).searchParams.get('batchId');

    if (!batchId) {
      const suggestion = await getLatestSuggestion(ctx, id);
      return NextResponse.json({ suggestion, batchMessageCount: null, pending: false });
    }

    const suggestion = await prisma.aiSuggestion.findFirst({
      where: { tenantId: ctx.tenantId, customerId: id, batchId },
      orderBy: { createdAt: 'desc' },
    });

    const batchMessageCount = await countBatchMessages(ctx.tenantId, batchId);

    return NextResponse.json({
      suggestion,
      batchMessageCount,
      pending: suggestion === null,
    });
  } catch (error) {
    return jsonError(error, 'suggestion:get');
  }
}
