import Link from 'next/link';
import { NeedHumanBadge, StageBadge } from '@/components/stage-badge';
import { formatRelative } from '@/lib/format';
import { classifyCustomerForQueue, isActionable, type QueueTone } from '@/lib/customer-queue';
import { env } from '@/lib/env';
import { requirePageAuth } from '@/server/auth';
import { listCustomers } from '@/server/repositories/customers';

export const metadata = { title: '客户 · ZigoAI Mini' };

const TONE_STYLES: Record<QueueTone, string> = {
  rose: 'border-rose-200 bg-rose-50 text-rose-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-700',
  indigo: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  slate: 'border-slate-200 bg-slate-50 text-slate-600',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
};

/**
 * 客户列表 = **待办队列**。
 *
 * 排序不再是"最近更新"，而是"我现在该处理谁"：需要人工 → 该跟进 → 待回复 → 待判断 → 已结束。
 * 判据来自一个纯函数（`customer-queue.ts`，有单元测试），所以排序规则本身是可解释、可验收的。
 */
export default async function CustomersPage() {
  const ctx = await requirePageAuth();
  const customers = await listCustomers(ctx);

  const now = new Date();

  const queue = customers
    .map((customer) => ({
      customer,
      queue: classifyCustomerForQueue({
        needHuman: Boolean(customer.state?.needHuman),
        leadStage: customer.state?.leadStage ?? 'NEW',
        lastCustomerMessageAt: customer.state?.lastCustomerMessageAt ?? null,
        idleMinutes: env.followUpIdleMinutes,
        now,
      }),
    }))
    // 同一档内：客户发言越晚越靠前（谁刚说完话谁最急）
    .sort((a, b) => {
      if (a.queue.priority !== b.queue.priority) return a.queue.priority - b.queue.priority;
      const aAt = a.customer.state?.lastCustomerMessageAt?.getTime() ?? 0;
      const bAt = b.customer.state?.lastCustomerMessageAt?.getTime() ?? 0;
      return bAt - aAt;
    });

  const actionable = queue.filter((item) => isActionable(item.queue.bucket));
  const needHumanCount = queue.filter((item) => item.queue.bucket === 'NEED_HUMAN').length;
  const followUpCount = queue.filter((item) => item.queue.bucket === 'FOLLOW_UP').length;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">客户</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {ctx.role === 'SALES' ? '你名下负责的客户' : `${ctx.tenantName} 的全部客户`}
            ，共 {customers.length} 位 —— 按**该处理谁**排序
          </p>
        </div>
        <Link
          href="/customers/new"
          className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          新建客户
        </Link>
      </div>

      {/* 待办汇总：让销售一眼知道"今天有没有活" */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3">
          <div className="text-xs text-rose-700">需要人工介入</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-rose-800" data-testid="queue-need-human">
            {needHumanCount}
          </div>
          <div className="text-[11px] text-rose-600">客户投诉 / 高价值 / 规则红线 —— 等你亲自接</div>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <div className="text-xs text-amber-700">该主动跟进</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-amber-800" data-testid="queue-follow-up">
            {followUpCount}
          </div>
          <div className="text-[11px] text-amber-600">
            客户静默超过 {env.followUpIdleMinutes} 分钟，建议回访
          </div>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3">
          <div className="text-xs text-indigo-700">待办合计</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-indigo-800" data-testid="queue-actionable">
            {actionable.length}
          </div>
          <div className="text-[11px] text-indigo-600">需要人工 + 该跟进 + 待回复</div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">优先级</th>
              <th className="px-4 py-2.5 font-medium">客户</th>
              <th className="px-4 py-2.5 font-medium">阶段</th>
              <th className="px-4 py-2.5 font-medium">当前意图</th>
              <th className="px-4 py-2.5 font-medium">消息</th>
              <th className="px-4 py-2.5 font-medium">负责人</th>
              <th className="px-4 py-2.5 font-medium">最后消息</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {queue.map(({ customer, queue: classification }) => (
              <tr key={customer.id} className="transition hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_STYLES[classification.tone]}`}
                    title={classification.hint}
                  >
                    {classification.label}
                  </span>
                </td>
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
                <td className="px-4 py-3 text-slate-500">
                  {formatRelative(customer.state?.lastCustomerMessageAt ?? customer.updatedAt)}
                </td>
              </tr>
            ))}
            {queue.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-400">
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
