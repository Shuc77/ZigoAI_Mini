import { NextResponse } from 'next/server';
import { z } from 'zod';
import { explainFollowUp, scanFollowUps, timeTravelCustomer } from '@/lib/agent/followup';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { requireCustomer } from '@/server/repositories/customers';

export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  /**
   * SCAN        —— 对本客户立即做一次跟进判定（满足条件就生成跟进建议）
   * TIME_TRAVEL —— 演示用：把"客户最后发言时间"往前拨 N 分钟，立刻复现"静默超时"
   */
  action: z.enum(['SCAN', 'TIME_TRAVEL']),
  minutes: z.number().int().min(1).max(10_080).optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const { id } = await params;
    await requireCustomer(ctx, id);

    const decision = await explainFollowUp(id);
    return NextResponse.json({ decision });
  } catch (error) {
    return jsonError(error, 'followup:explain');
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const { id } = await params;
    const customer = await requireCustomer(ctx, id);

    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '参数不合法' },
        { status: 400 },
      );
    }

    if (parsed.data.action === 'TIME_TRAVEL') {
      const minutes = parsed.data.minutes ?? 30;
      await timeTravelCustomer(id, minutes);
      const decision = await explainFollowUp(id);
      return NextResponse.json({
        ok: true,
        action: 'TIME_TRAVEL',
        minutes,
        decision,
        message: `已把客户最后发言时间往前拨 ${minutes} 分钟（仅改状态表，不改消息本身的时间）`,
      });
    }

    // SCAN：**先取判定结论，再执行**。
    // 顺序很重要：跟进成功后会写 lastFollowUpAt，若之后再求值就只会得到"冷却期中"，看起来自相矛盾。
    const decisionBefore = await explainFollowUp(id);

    // 只针对本客户扫描（不去动同租户其它客户，避免点一次按钮影响一片数据）
    const results = await scanFollowUps({ tenantId: ctx.tenantId, customerId: customer.id });
    const hit = results.find((item) => item.customerId === customer.id);

    return NextResponse.json({
      ok: true,
      action: 'SCAN',
      followed: Boolean(hit),
      /** 执行前的判定结论（也就是"为什么跟进 / 为什么不跟进"） */
      decision: decisionBefore,
      suggestionId: hit?.suggestionId ?? null,
    });
  } catch (error) {
    return jsonError(error, 'followup:run');
  }
}
