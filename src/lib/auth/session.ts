import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import type { AuthContext } from '@/lib/types';

/**
 * 会话：自签 JWT（HS256）放在 httpOnly Cookie 里。
 *
 * 为什么不用 NextAuth：24H 内它的配置面、回调链、适配器都是额外的心智负担；
 * 而我们的需求只有三点——登录、带租户上下文的会话、登出。手写 60 行更可解释，
 * 也更容易在"现场加需求"时改动。
 *
 * 关键安全点：tenantId / role 都写进**服务端签名**的 token，前端无法伪造；
 * 所有数据访问都以 token 里的 tenantId 为准，绝不信任请求体/查询参数里的租户 id。
 */
const COOKIE_NAME = 'zigoai_session';
const ALG = 'HS256';
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12 小时，覆盖演示时长

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.sessionSecret);
}

export async function createSessionToken(ctx: AuthContext): Promise<string> {
  return new SignJWT({
    userId: ctx.userId,
    userName: ctx.userName,
    email: ctx.email,
    role: ctx.role,
    tenantId: ctx.tenantId,
    tenantName: ctx.tenantName,
    tenantSlug: ctx.tenantSlug,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

/** 读取并校验当前会话；无效/过期/被篡改一律返回 null */
export async function readSession(): Promise<AuthContext | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.tenantId !== 'string' ||
      (payload.role !== 'SALES' && payload.role !== 'MANAGER')
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      userName: String(payload.userName ?? ''),
      email: String(payload.email ?? ''),
      role: payload.role,
      tenantId: payload.tenantId,
      tenantName: String(payload.tenantName ?? ''),
      tenantSlug: String(payload.tenantSlug ?? ''),
    };
  } catch {
    return null;
  }
}

export async function writeSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
