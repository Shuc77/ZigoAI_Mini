import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveBatchId, scheduleBatch, sweepExpiredBatches } from '@/lib/agent/batch';
import { env } from '@/lib/env';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { appendCustomerMessage, listMessages } from '@/server/repositories/messages';
import { getLatestSuggestion } from '@/server/repositories/suggestions';

export const runtime = 'nodejs';
/** AI 判断是这一步的主要耗时来源，给足超时（自托管下也受此约束） */
export const maxDuration = 60;

const bodySchema = z.object({
  content: z.string().trim().min(1, '消息内容不能为空').max(2000),
  /** 客户端生成的去重键：同一条消息重复提交只会落库一次，也不会重复调用 AI */
  clientMessageId: z.string().trim().min(8).max(64).optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const { id } = await params;
    const messages = await listMessages(ctx, id);
    return NextResponse.json({ messages });
  } catch (error) {
    return jsonError(error, 'messages:list');
  }
}

/**
 * 客户消息入口 —— 系统的"主干起点"。
 *
 * 连续消息合并（进阶挑战 2）就落在这里：
 *   ① 决定这条消息属于哪一批（窗口内复用当前批次，否则开新批次）
 *   ② 消息入库并带上 batchId
 *   ③ **不立即调用 AI**，而是安排窗口到期后统一判断（客户还在打字就再等等）
 *   ④ 顺带做一次兜底扫描，拾起"窗口已过期但没有建议"的历史批次（进程重启后也不会丢）
 *
 * 因此这个接口的响应是"已收到，待判断"（pending），前端会轮询建议是否生成完成。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const { id } = await params;
    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '参数不合法' },
        { status: 400 },
      );
    }

    // ① 先决定批次（依据是"已有的"消息，所以必须在写入之前）
    const { batchId, isNewBatch } = await resolveBatchId(ctx, id);

    // ② 入库（幂等仍由 clientMessageId 保证）
    const result = await appendCustomerMessage(ctx, {
      customerId: id,
      content: parsed.data.content,
      clientMessageId: parsed.data.clientMessageId,
      batchId,
    });

    // 重复提交：不重复调用 AI，返回最近一次判断
    if (result.deduplicated) {
      const suggestion = await getLatestSuggestion(ctx, id);
      return NextResponse.json({
        message: result.message,
        deduplicated: true,
        suggestion,
        pending: false,
        agentError: null,
      });
    }

    // ③ 安排窗口到期后的统一判断（同一批次会顺延，避免客户还在打字时就抢答）
    scheduleBatch({ batchId, tenantId: ctx.tenantId, customerId: id });

    // ④ 兜底扫描：不与本次请求同步等待，失败也不影响消息入库
    void sweepExpiredBatches().catch((error) => console.error('[api/messages] 兜底扫描失败', error));

    return NextResponse.json(
      {
        message: result.message,
        deduplicated: false,
        pending: true,
        batchId,
        isNewBatch,
        batchWindowMs: env.batchWindowMs,
        suggestion: null,
        agentError: null,
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, 'messages:create');
  }
}
