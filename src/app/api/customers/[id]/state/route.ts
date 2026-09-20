import { NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { applyHumanStateAction } from '@/server/repositories/customers';

export const runtime = 'nodejs';

const bodySchema = z.object({
  action: z.enum(['RESOLVE_HUMAN', 'CONFIRM_WON', 'CONFIRM_LOST', 'REOPEN']),
});

/** 人工状态操作：解除"需人工"标记、确认成交、确认流失 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const { id } = await params;
    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json({ code: 'BAD_REQUEST', message: '不支持的操作' }, { status: 400 });
    }

    const state = await applyHumanStateAction(ctx, id, parsed.data.action);
    return NextResponse.json({ state });
  } catch (error) {
    return jsonError(error, 'customers:state');
  }
}
