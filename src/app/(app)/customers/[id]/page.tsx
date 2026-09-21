import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AiSuggestionCard } from '@/components/ai-suggestion-card';
import { NeedHumanBadge, StageBadge } from '@/components/stage-badge';
import { countBatchMessages, ensureInitialJudgment } from '@/lib/agent/batch';
import { explainFollowUp } from '@/lib/agent/followup';
import { HttpError } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { LEAD_STAGE_LABELS } from '@/lib/types';
import { requirePageAuth } from '@/server/auth';
import { requireCustomer } from '@/server/repositories/customers';
import { listMessages } from '@/server/repositories/messages';
import { getLatestSuggestion } from '@/server/repositories/suggestions';
import { getTenantConfig } from '@/server/repositories/tenants';
import { FollowupActions } from './followup-actions';
import { MessageComposer } from './message-composer';
import { MessageList } from './message-list';
import { StateActions } from './state-actions';
import { SuggestionActions } from './suggestion-actions';

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageAuth();

  // 跨租户/越权访问在这里变成 404（不暴露"存在但不属于你"）
  let customer;
  try {
    customer = await requireCustomer(ctx, id);
  } catch (error) {
    // 只把**真正的"找不到"**转成 404；其它错误（数据库抖动、连接超时…）
    // 必须原样抛出显示为错误页，否则会把真实故障伪装成"客户不存在"，排障时被误导
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }

  /*
   * 补跑"首次判断"：如果这个客户有客户消息却从未被判断过（种子数据、历史导入、迁移、
   * 或进程在聚合窗口期间重启造成），就在这里补一次 —— 否则会出现"还没有 AI 判断"与
   * 跟进区块"建议主动跟进"自相矛盾的画面。已经有判断时这个调用是零成本的（一次查询后直接返回）。
   */
  try {
    await ensureInitialJudgment({ tenantId: ctx.tenantId, customerId: customer.id });
  } catch (error) {
    // 补跑失败不能连累页面渲染：消息仍在，判断只是缺失，用户也可以点「重新生成」手动触发
    console.error('[customer-detail] 首次判断补跑失败', error);
  }

  const [messages, latestSuggestion, tenantConfig, followUpDecision] = await Promise.all([
    listMessages(ctx, customer.id),
    getLatestSuggestion(ctx, customer.id),
    getTenantConfig(ctx),
    explainFollowUp(customer.id),
  ]);
  const state = customer.state;

  /**
   * "已回复、等待客户回应" —— 派生状态，不额外调用 AI。
   * 判据：最新一条建议已发送，且此后客户没有再发消息（销售的最后一次外发晚于客户最后一次说话）。
   */
  const lastCustomerMessageAt = state?.lastCustomerMessageAt ?? null;
  const waitingForCustomer = Boolean(
    latestSuggestion?.sentMessageId &&
      latestSuggestion.sentAt &&
      (!lastCustomerMessageAt || latestSuggestion.sentAt > lastCustomerMessageAt),
  );

  /**
   * 本轮合并了多少条客户消息 —— 连续消息合并的可见证据。
   * 判据：本次建议绑定的 batchId 下有多少条客户消息。
   */
  const batchMessageCount = latestSuggestion?.batchId
    ? await countBatchMessages(ctx.tenantId, latestSuggestion.batchId)
    : null;

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

      {/*
        两栏等高布局。
        为什么：左栏（聊天）与右栏（状态 + AI 判断 + 发送区）内容都会随对话增长，
        如果各自算高度，就会出现"一个已经到底、另一个还在滚"的错位，页面还会多出第三条滚动条。
        做法：给栅格一个确定的视口高度，栅格项默认 stretch → 两栏严格等高；
        左栏卡片内部用 flex 分配（聊天区 flex-1 吸收剩余高度），右栏整体独立滚动。
        窄屏不加固定高度，自动退回单列堆叠。
      */}
      <div className="grid gap-4 lg:h-[calc(100vh-17rem)] lg:min-h-[540px] lg:grid-cols-3">
        {/* 左：聊天记录 + 录入 */}
        <div className="min-h-0 lg:col-span-2">
          <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-medium">聊天记录</h2>
              <span className="text-xs text-slate-400">{messages.length} 条</span>
            </div>

            <MessageList
              messages={messages.map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                createdAt: message.createdAt.toISOString(),
              }))}
            />

            <div className="shrink-0 border-t border-slate-100 px-4 py-3">
              <MessageComposer customerId={customer.id} />
            </div>
          </div>
        </div>

        {/*
          右栏：独立滚动 + 吸顶。
          为什么需要：客户状态、AI 判断、发送区都会随每轮对话增长（已发送/实际发送/系统修正等区块），
          如果让整页跟着变长，聊到十几轮后右栏会长到需要一直滚动，体验很差。
          现在两栏各自有固定高度：左栏聊聊天记录滚动，右栏独立滚动，页面高度基本恒定。
        */}
        <div className="min-h-0 space-y-4 lg:h-full lg:overflow-y-auto lg:pr-1">
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

            <FollowupActions customerId={customer.id} decision={followUpDecision} />
          </div>

          <AiSuggestionCard
            suggestion={latestSuggestion}
            rules={tenantConfig.rules}
            waitingForCustomer={waitingForCustomer}
            batchMessageCount={batchMessageCount}
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
