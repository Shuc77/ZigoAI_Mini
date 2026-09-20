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

export async function writeSessionCookie(
  token: string,
  options: { secure: boolean },
): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(options: { secure: boolean }): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    maxAge: 0,
  });
}

/**
 * 判断当前请求是否走 HTTPS —— 决定 Cookie 是否加 `Secure` 标记。
 *
 * 为什么不能用 `NODE_ENV === 'production'`（这是上线时踩的真实 bug）：
 * 本次部署是 `http://IP:8080`（无域名、无证书），而带 `Secure` 的 Cookie 在 HTTP 下
 * 会被浏览器**直接丢弃**（localhost 例外）。症状是"点登录没反应 / 一直回到登录页"，
 * 而接口本身返回 200 —— 尤其阴险的是：用 Node 写的冒烟脚本不在乎 Secure 标记，
 * 所以自动化测试全绿，只有真实浏览器才复现。
 *
 * 策略：优先读显式配置 `COOKIE_SECURE`，否则按请求协议自动判断（支持反代透传的 x-forwarded-proto）。
 */
export function isSecureRequest(request: Request): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === 'true') return true;
  if (override === 'false') return false;

  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https';
  }

  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
