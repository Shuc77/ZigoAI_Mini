import { NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { sendSuggestionReply } from '@/server/repositories/messages';

export const runtime = 'nodejs';

const bodySchema = z.object({
  /** 销售最终确认的文本（可能已在 AI 建议基础上修改） */
  reply: z.string().trim().min(1, '回复内容不能为空').max(2000),
});

/**
 * 销售点击「发送给客户」。
 * 发送内容会真实进入聊天记录，并在下一轮 AI 判断中作为历史对话被读取。
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

    const result = await sendSuggestionReply(ctx, id, parsed.data.reply);
    return NextResponse.json({ message: result.message, edited: result.edited }, { status: 201 });
  } catch (error) {
    return jsonError(error, 'suggestions:send');
  }
}
