import { NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { appendCustomerMessage, listMessages } from '@/server/repositories/messages';

export const runtime = 'nodejs';

const bodySchema = z.object({
  content: z.string().trim().min(1, '消息内容不能为空').max(2000),
  /** 客户端生成的去重键：同一条消息重复提交只会落库一次 */
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

    return NextResponse.json(
      {
        message: result.message,
        deduplicated: result.deduplicated,
      },
      { status: result.deduplicated ? 200 : 201 },
    );
  } catch (error) {
    return jsonError(error, 'messages:create');
  }
}
