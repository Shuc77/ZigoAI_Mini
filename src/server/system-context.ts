import type { AuthContext } from '@/lib/types';

/**
 * 系统任务使用的鉴权上下文（**仅供后台任务使用，绝不可由请求构造**）。
 *
 * 为什么需要它：定时/后台任务（连续消息合并的窗口到期处理、Follow-up 扫描）没有"当前登录用户"，
 * 但它们必须在**某个租户内**操作数据。这里用 MANAGER 级别的租户作用域：
 *   - 作用域仍然被限制在单个 tenantId 内（不会跨租户）
 *   - 不做 assignee 过滤（系统任务要处理该租户下所有客户）
 *
 * 安全约束：本文件只允许被 `src/lib/agent/batch.ts`、`src/lib/agent/followup.ts`
 * 等后台任务模块引用；任何 API 路由都不得用它来"提权"。
 */
export function systemAuthContext(tenantId: string, tenantName = ''): AuthContext {
  return {
    userId: 'system',
    userName: '系统任务',
    email: 'system@internal',
    role: 'MANAGER',
    tenantId,
    tenantName,
    tenantSlug: '',
  };
}
