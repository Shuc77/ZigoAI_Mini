import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AiSuggestionCard } from '@/components/ai-suggestion-card';
import { NeedHumanBadge, StageBadge } from '@/components/stage-badge';
import { formatDateTime, formatRelative } from '@/lib/format';
import { LEAD_STAGE_LABELS } from '@/lib/types';
import { requirePageAuth } from '@/server/auth';
import { requireCustomer } from '@/server/repositories/customers';
import { listMessages } from '@/server/repositories/messages';
import { getLatestSuggestion } from '@/server/repositories/suggestions';
import { getTenantConfig } from '@/server/repositories/tenants';
import { MessageComposer } from './message-composer';
import { StateActions } from './state-actions';
import { SuggestionActions } from './suggestion-actions';

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageAuth();

  // 跨租户/越权访问在这里变成 404（不暴露"存在但不属于你"）
  let customer;
  try {
    customer = await requireCustomer(ctx, id);
  } catch {
    notFound();
  }

  const [messages, latestSuggestion, tenantConfig] = await Promise.all([
    listMessages(ctx, customer.id),
    getLatestSuggestion(ctx, customer.id),
    getTenantConfig(ctx),
  ]);
  const state = customer.state;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Link href="/customers" className="hover:text-indigo-600">
          ← 客户列表
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700">{customer.name}</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{customer.name}</h1>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>微信：{customer.handle}</span>
              {customer.phone ? <span>电话：{customer.phone}</span> : null}
              {customer.source ? <span>来源：{customer.source}</span> : null}
              <span>负责人：{customer.assignee?.name ?? '未分配'}</span>
            </div>
            {customer.note ? <p className="mt-2 text-xs text-slate-500">备注：{customer.note}</p> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {state ? <StageBadge stage={state.leadStage} /> : null}
            {state?.needHuman ? <NeedHumanBadge reason={state.humanReason} /> : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 左：聊天记录 + 录入 */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-medium">聊天记录</h2>
              <span className="text-xs text-slate-400">{messages.length} 条</span>
            </div>

            <div className="max-h-[520px] space-y-3 overflow-y-auto px-4 py-4">
              {messages.map((message) => {
                const isCustomer = message.role === 'CUSTOMER';
                return (
                  <div key={message.id} className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`}>
                    <div className="max-w-[80%]">
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
                        <span>{isCustomer ? '客户' : '销售'}</span>
                        <span>{formatDateTime(message.createdAt)}</span>
                      </div>
                      <div
                        className={`prewrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                          isCustomer
                            ? 'border border-slate-200 bg-slate-50 text-slate-800'
                            : 'bg-indigo-600 text-white'
                        }`}
                      >
                        {message.content}
                      </div>
                    </div>
                  </div>
                );
              })}

              {messages.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">还没有聊天记录</p>
              ) : null}
            </div>

            <div className="border-t border-slate-100 px-4 py-3">
              <MessageComposer customerId={customer.id} />
            </div>
          </div>
        </div>

        {/* 右：Customer State（M2 起 AI 判断卡片会加在这里） */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-medium">客户状态（Customer State）</h2>
            </div>
            <dl className="divide-y divide-slate-100 text-sm">
              <div className="flex items-center justify-between px-4 py-2.5">
                <dt className="text-slate-500">销售阶段</dt>
                <dd className="font-medium">{state ? LEAD_STAGE_LABELS[state.leadStage] : '—'}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <dt className="text-slate-500">当前意图</dt>
                <dd className="font-medium">{state?.intent ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <dt className="text-slate-500">是否需人工</dt>
                <dd className="font-medium">
                  {state?.needHuman ? `是（${state.humanReason ?? '未说明'}）` : '否'}
                </dd>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <dt className="text-slate-500">最后客户消息</dt>
                <dd className="font-medium">{formatRelative(state?.lastCustomerMessageAt)}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <dt className="text-slate-500">跟进次数</dt>
                <dd className="font-medium">{state?.followUpCount ?? 0}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <dt className="text-slate-500">状态版本</dt>
                <dd className="font-mono text-xs text-slate-500">v{state?.version ?? 0}</dd>
              </div>
            </dl>

            <StateActions
              customerId={customer.id}
              needHuman={state?.needHuman ?? false}
              leadStage={state?.leadStage ?? 'NEW'}
            />
          </div>

          <AiSuggestionCard
            suggestion={latestSuggestion}
            rules={tenantConfig.rules}
            actions={
              latestSuggestion ? (
                <SuggestionActions
                  suggestionId={latestSuggestion.id}
                  originalReply={latestSuggestion.reply}
                  alreadySent={latestSuggestion.sentMessageId !== null}
                  sentFinalReply={latestSuggestion.finalReply}
                />
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}
