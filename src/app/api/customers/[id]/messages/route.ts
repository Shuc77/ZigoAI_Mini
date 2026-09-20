import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAgent } from '@/lib/agent/pipeline';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { appendCustomerMessage, listMessages } from '@/server/repositories/messages';
import { getLatestSuggestion } from '@/server/repositories/suggestions';

export const runtime = 'nodejs';
/** AI 判断是这一步的主要耗时来源，给足超时（Vercel/Next 默认值在自托管下也受此约束） */
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
 *   写入消息（幂等）
 *     → 触发 AI pipeline（M6 会在这里插入"连续消息聚合窗口"）
 *     → 返回 建议 / 状态变化 / 是否降级
 *
 * 幂等命中时**不会重复调用 AI**，直接返回最近一条判断结果。
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

    const result = await appendCustomerMessage(ctx, {
      customerId: id,
      content: parsed.data.content,
      clientMessageId: parsed.data.clientMessageId,
    });

    // 重复提交：不重复调用 AI，返回最近一次判断
    if (result.deduplicated) {
      const suggestion = await getLatestSuggestion(ctx, id);
      return NextResponse.json({
        message: result.message,
        deduplicated: true,
        suggestion,
        agentError: null,
      });
    }

    try {
      const agent = await runAgent({
        ctx,
        customerId: id,
        messageIds: [result.message.id],
        trigger: 'NEW_MESSAGE',
      });

      return NextResponse.json(
        {
          message: result.message,
          deduplicated: false,
          suggestion: agent.suggestion,
          adjustments: agent.adjustments,
          state: agent.state,
          status: agent.status,
          attempts: agent.attempts,
          // 规则守护的判定结果与交接规则的触发说明（排障与演示都用得上）
          guardViolations: agent.guardViolations,
          handoffNotes: agent.handoffNotes,
          agentError: null,
        },
        { status: 201 },
      );
    } catch (agentError) {
      // 消息已经入库，AI 失败不能连累"消息发送"这件事本身
      console.error('[api/messages] AI pipeline 失败', agentError);
      return NextResponse.json(
        {
          message: result.message,
          deduplicated: false,
          suggestion: null,
          agentError: (agentError as Error).message,
        },
        { status: 201 },
      );
    }
  } catch (error) {
    return jsonError(error, 'messages:create');
  }
}
