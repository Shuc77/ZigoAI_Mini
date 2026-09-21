import { NextResponse } from 'next/server';
import { z } from 'zod';
import { RULE_GUARDS } from '@/lib/types';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { getTenantConfig, updateTenantConfig } from '@/server/repositories/tenants';

export const runtime = 'nodejs';

export const configSchema = z.object({
  salesGoal: z.string().trim().min(1, '销售目标不能为空').max(200),
  tone: z.string().trim().min(1, '语气要求不能为空').max(200),
  rules: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(10),
        text: z.string().trim().min(1, '规则内容不能为空').max(200),
        guard: z.enum(RULE_GUARDS).optional(),
      }),
    )
    .max(20),
  forbidden: z.array(z.string().trim().min(1).max(100)).max(20),
  handoff: z.object({
    triggers: z.object({
      complaint: z.boolean(),
      wantsHuman: z.boolean(),
      aiUnsure: z.boolean(),
      highValue: z.boolean(),
      ruleConflict: z.boolean(),
      // 新增触发器：老客户端（或不带这两个字段的调用）一律回落到默认值 true，
      // 避免"保存一次配置"就把新能力静默关掉
      churnRisk: z.boolean().default(true),
      dealClosing: z.boolean().default(true),
    }),
    keywords: z.array(z.string().trim().min(1).max(20)).max(20),
    amountThreshold: z.number().int().positive().max(100_000_000).nullable(),
    note: z.string().trim().max(200),
  }),
});

export async function GET() {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();
    return NextResponse.json({ config: await getTenantConfig(ctx) });
  } catch (error) {
    return jsonError(error, 'tenant:config:get');
  }
}

/** 保存企业销售规则 + 交接规则（仅主管） */
export async function PUT(request: Request) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const parsed = configSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '参数不合法' },
        { status: 400 },
      );
    }

    await updateTenantConfig(ctx, parsed.data);
    return NextResponse.json({ config: await getTenantConfig(ctx) });
  } catch (error) {
    return jsonError(error, 'tenant:config:update');
  }
}
