import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { unauthorized } from '@/lib/errors';
import { createCustomer, listCustomers } from '@/server/repositories/customers';

export const runtime = 'nodejs';

const createSchema = z.object({
  name: z.string().trim().min(1, '请填写客户姓名').max(50),
  handle: z.string().trim().min(1, '请填写微信号或联系人标识').max(100),
  phone: z.string().trim().max(50).optional().nullable(),
  source: z.string().trim().max(50).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  assigneeId: z.string().trim().optional().nullable(),
});

export async function GET() {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();
    const customers = await listCustomers(ctx);
    return NextResponse.json({ customers });
  } catch (error) {
    return jsonError(error, 'customers:list');
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '参数不合法' },
        { status: 400 },
      );
    }

    const customer = await createCustomer(ctx, parsed.data);
    return NextResponse.json({ customer }, { status: 201 });
  } catch (error) {
    return jsonError(error, 'customers:create');
  }
}
