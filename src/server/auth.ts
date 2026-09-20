import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth/session';
import { forbidden } from '@/lib/errors';
import type { AuthContext } from '@/lib/types';

/**
 * 页面/接口的统一入口守卫。
 *
 * 约定：
 *  - 页面（Server Component）：未登录 → redirect('/login')
 *  - 接口（Route Handler）：未登录 → 返回 401，由路由自行响应
 *
 * 这里也是 Tenant 隔离的起点：AuthContext 全部来自**服务端签名**的会话，
 * 任何来自请求体/URL 的 tenantId 一律忽略。
 */
export async function requirePageAuth(): Promise<AuthContext> {
  const ctx = await readSession();
  if (!ctx) redirect('/login');
  return ctx;
}

export async function getApiAuth(): Promise<AuthContext | null> {
  return readSession();
}

/** 主管专属操作（例如修改本企业销售规则） */
export function assertManager(ctx: AuthContext): void {
  if (ctx.role !== 'MANAGER') {
    throw forbidden('只有销售主管可以修改企业销售规则');
  }
}
