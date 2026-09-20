import Link from 'next/link';
import { LogoutButton } from './logout-button';
import { requirePageAuth } from '@/server/auth';

/**
 * 登录后的应用外壳。
 * 注意：requirePageAuth 在**服务端**执行，AuthContext 来自签名 Cookie，
 * 前端拿不到也改不了 tenantId / role。
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageAuth();

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-4">
            <Link href="/customers" className="text-sm font-semibold tracking-tight text-slate-900">
              ZigoAI Mini
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/customers"
                className="rounded-lg px-2.5 py-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
              >
                客户
              </Link>
              <Link
                href="/tenant/config"
                className="rounded-lg px-2.5 py-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
              >
                企业规则
              </Link>
              <Link
                href="/ai-logs"
                className="rounded-lg px-2.5 py-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
              >
                AI 日志
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
              {ctx.tenantName}
            </span>
            <span className="text-xs text-slate-500">
              {ctx.userName}
              <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                {ctx.role === 'MANAGER' ? '主管' : '销售'}
              </span>
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
