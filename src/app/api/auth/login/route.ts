import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSessionToken, writeSessionCookie } from '@/lib/auth/session';
import { verifyPassword } from '@/lib/auth/password';
import { prisma } from '@/lib/db';
import { HttpError } from '@/lib/errors';

export const runtime = 'nodejs';

const loginSchema = z.object({
  email: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ code: 'BAD_REQUEST', message: '请输入邮箱与密码' }, { status: 400 });
    }

    const email = parsed.data.email.toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email },
      include: { tenant: true },
    });

    // 统一失败文案：不暴露"该邮箱是否存在"
    const invalid = NextResponse.json(
      { code: 'UNAUTHORIZED', message: '邮箱或密码不正确' },
      { status: 401 },
    );
    if (!user) return invalid;

    const passwordOk = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!passwordOk) return invalid;

    const token = await createSessionToken({
      userId: user.id,
      userName: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      tenantName: user.tenant.name,
      tenantSlug: user.tenant.slug,
    });
    await writeSessionCookie(token);

    return NextResponse.json({
      ok: true,
      user: { id: user.id, name: user.name, role: user.role, tenant: user.tenant.name },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
    }
    console.error('[api/auth/login] 未预期错误', error);
    return NextResponse.json({ code: 'INTERNAL_ERROR', message: '登录失败，请稍后重试' }, { status: 500 });
  }
}
