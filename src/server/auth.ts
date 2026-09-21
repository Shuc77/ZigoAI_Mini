import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
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

/**
 * 会话签名有效 ≠ 会话仍然可用。
 *
 * 会话里存的是签发那一刻的 `userId` 与 `tenantId`。如果这些记录后来不存在了
 * （账号被删、或早期版本的"重置演示数据"会删除并重建租户），请求就会以各种奇怪的方式失败：
 * 企业规则页 500、销售账号看到空客户列表、客户详情页 404。
 * 用户看到的现象是"**偶尔进不去，重新登录就好了**"。
 *
 * 因此这里显式校验一次：指向的记录不存在就当作**会话已失效**处理（跳登录 / 返回 401），
 * 而不是把内部不一致暴露成 500 或 404。
 */
async function sessionStillValid(ctx: AuthContext): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  return user !== null;
}

export async function requirePageAuth(): Promise<AuthContext> {
  const ctx = await readSession();
  if (!ctx) redirect('/login');
  if (!(await sessionStillValid(ctx))) redirect('/login?reason=session_expired');
  return ctx;
}

export async function getApiAuth(): Promise<AuthContext | null> {
  const ctx = await readSession();
  if (!ctx) return null;
  return (await sessionStillValid(ctx)) ? ctx : null;
}

/** 主管专属操作（例如修改本企业销售规则） */
export function assertManager(ctx: AuthContext): void {
  if (ctx.role !== 'MANAGER') {
    throw forbidden('只有销售主管可以修改本企业销售规则');
  }
}
