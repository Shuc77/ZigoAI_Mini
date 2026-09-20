import Link from 'next/link';
import { NeedHumanBadge, StageBadge } from '@/components/stage-badge';
import { requirePageAuth } from '@/server/auth';
import { listCustomers } from '@/server/repositories/customers';

export const metadata = { title: '客户 · ZigoAI Mini' };

function formatRelative(date: Date | null | undefined): string {
  if (!date) return '—';
  const diffMs = Date.now() - new Date(date).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export default async function CustomersPage() {
  const ctx = await requirePageAuth();
  const customers = await listCustomers(ctx);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">客户</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {ctx.role === 'SALES' ? '你名下负责的客户' : `${ctx.tenantName} 的全部客户`}
            ，共 {customers.length} 位
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">客户</th>
              <th className="px-4 py-2.5 font-medium">阶段</th>
              <th className="px-4 py-2.5 font-medium">当前意图</th>
              <th className="px-4 py-2.5 font-medium">消息</th>
              <th className="px-4 py-2.5 font-medium">负责人</th>
              <th className="px-4 py-2.5 font-medium">最后消息</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {customers.map((customer) => (
              <tr key={customer.id} className="transition hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <Link href={`/customers/${customer.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                    {customer.name}
                  </Link>
                  <div className="mt-0.5 text-xs text-slate-400">微信：{customer.handle}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {customer.state ? <StageBadge stage={customer.state.leadStage} /> : <span className="text-xs text-slate-400">—</span>}
                    {customer.state?.needHuman ? <NeedHumanBadge reason={customer.state.humanReason} /> : null}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-600">{customer.state?.intent ?? '—'}</td>
                <td className="px-4 py-3 text-slate-600">{customer._count.messages}</td>
                <td className="px-4 py-3 text-slate-600">{customer.assignee?.name ?? '未分配'}</td>
                <td className="px-4 py-3 text-slate-500">{formatRelative(customer.updatedAt)}</td>
              </tr>
            ))}
            {customers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                  还没有客户
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
