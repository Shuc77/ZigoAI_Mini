import Link from 'next/link';
import { notFound } from 'next/navigation';

import { formatDateTime } from '@/lib/format';
import { LEAD_STAGE_LABELS, parseTenantRules } from '@/lib/types';
import { parseAdjustments } from '@/lib/agent/state';
import { requirePageAuth } from '@/server/auth';
import { getTenantConfig } from '@/server/repositories/tenants';
import { findSuggestionById } from '@/server/repositories/suggestions';

export const metadata = { title: '判断链路 · ZigoAI Mini' };

/**
 * 判断链路详情 —— 把"这一次判断到底怎么来的"完整摊开。
 *
 * 为什么要有这个页面（它解决的问题很具体）：
 *   1. **排障**：客户抱怨"怎么这么久才回"时，看总耗时 → 分段耗时 → 模型耗时 / 首字节，
 *      一眼能分清是**聚合窗口**、**模型生成**还是**落库**的问题，而不是猜。
 *   2. **可回放**：卡片上只给销售看结论，但主管/开发者需要看到**模型收到的原文**与**模型的原始输出** ——
 *      这是"AI 决策可回放"这一条从口号变成可以点开的东西。
 *   3. **可解释**：每次系统改写（阶段被拦、投诉升级、规则重写）都在这里有出处与理由。
 *
 * 不参与任何业务判断：这里全是只读展示，改坏了也不会影响销售链路。
 */

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  SUCCESS: { label: '调用成功', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  RETRY_OK: { label: '重试后成功', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  FALLBACK: { label: '已降级为人工', className: 'border-amber-200 bg-amber-50 text-amber-700' },
  ERROR: { label: '调用失败', className: 'border-rose-200 bg-rose-50 text-rose-700' },
};

const TRIGGER_LABELS: Record<string, string> = {
  NEW_MESSAGE: '客户新消息',
  REGENERATE: '销售手动重新判断',
  FOLLOW_UP: '静默跟进',
  INITIAL_BACKFILL: '首次判断补跑',
};

type TraceStage = { key: string; label: string; ms: number; detail?: string };
type Trace = {
  totalMs?: number;
  stages?: TraceStage[];
  model?: {
    attempts?: number;
    maxTokens?: number;
    finishReason?: string | null;
    ttfbMs?: number | null;
    errorKinds?: string[];
  };
  context?: {
    historyMessages?: number;
    newMessages?: number;
    rulesCount?: number;
    handoffKeywords?: number;
  };
  guards?: { violations?: Array<{ ruleId: string; message: string }>; retries?: number };
  handoff?: { needHuman?: boolean; reason?: string | null; notes?: string[] };
  state?: { from?: string; to?: string; adjustments?: Array<{ field: string; rule: string }> };
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-medium">{title}</div>
      <div className="px-4 py-3 text-sm">{children}</div>
    </div>
  );
}

export default async function AiCallTracePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageAuth();
  const { id } = await params;

  const suggestion = await findSuggestionById(ctx, id);
  if (!suggestion) notFound();

  const tenantConfig = await getTenantConfig(ctx);
  const ruleById = new Map(parseTenantRules(tenantConfig.rules).map((rule) => [rule.id, rule.text]));
  const trace = (suggestion.pipelineTrace ?? null) as Trace | null;
  const rawRequest = suggestion.rawRequest as { messages?: Array<{ role: string; content: string }> } | null;
  const adjustments = parseAdjustments(suggestion.stateAdjustments);
  const status = STATUS_LABELS[suggestion.status] ?? STATUS_LABELS.SUCCESS;
  const stages = trace?.stages ?? [];
  const slowest = Math.max(1, ...stages.map((stage) => stage.ms));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
        <Link href="/ai-logs" className="hover:text-indigo-600">
          ← AI 日志
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700">判断链路</span>
        <span className="text-slate-300">/</span>
        <Link href={`/customers/${suggestion.customerId}`} className="hover:text-indigo-600">
          {suggestion.customer?.name ?? '客户'}
        </Link>
      </div>

      {/* ---- 结论条：这次判断的结果与健康度 ---- */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">判断链路</h1>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>{formatDateTime(suggestion.createdAt)}</span>
              <span>{TRIGGER_LABELS[suggestion.trigger] ?? suggestion.trigger}</span>
              <span>{suggestion.model}</span>
              <span>prompt {suggestion.promptVersion}</span>
            </div>
          </div>
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${status.className}`}>
            {status.label}
          </span>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {[
            { label: '总耗时', value: `${trace?.totalMs ?? '—'} ms`, hint: '窗口 + 判断 + 落库' },
            {
              label: '模型耗时',
              value: suggestion.latencyMs !== null ? `${suggestion.latencyMs} ms` : '—',
              hint: trace?.model?.ttfbMs ? `首字节 ${trace.model.ttfbMs}ms，其余是生成` : '响应体读完才计时',
            },
            {
              label: 'Token',
              value: `${suggestion.promptTokens ?? 0} + ${suggestion.completionTokens ?? 0}`,
              hint: '输入 + 输出（含推理 token）',
            },
            {
              label: '调用次数',
              value: `${trace?.model?.attempts ?? 1} 次`,
              hint: (trace?.model?.errorKinds ?? []).length > 0 ? '首次不合格，已重试' : '一次成功',
            },
          ].map((card) => (
            <div key={card.label} className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">{card.label}</div>
              <div className="mt-0.5 text-base font-semibold text-slate-900">{card.value}</div>
              <div className="text-[11px] text-slate-400">{card.hint}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ---- 分段耗时：条形图直观看到"时间花在哪" ---- */}
      <Section title="环节耗时（条形长度 = 相对占比）">
        {stages.length === 0 ? (
          <p className="text-xs text-slate-500">
            这条记录产自旧版本（尚未记录链路信息）。新产生的判断都会带完整链路。
          </p>
        ) : (
          <ul className="space-y-2.5">
            {stages.map((stage) => (
              <li key={stage.key}>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium text-slate-700">{stage.label}</span>
                  <span className="font-mono text-slate-500">{stage.ms} ms</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-indigo-500"
                    style={{ width: `${Math.max(2, Math.round((stage.ms / slowest) * 100))}%` }}
                  />
                </div>
                {stage.detail ? <div className="mt-1 text-[11px] text-slate-500">{stage.detail}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- 判断结果 + 系统改写 ---- */}
        <Section title="这一步判了什么">
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-slate-50 px-2.5 py-2">
              <dt className="text-slate-500">客户意图</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{suggestion.customerIntent}</dd>
            </div>
            <div className="rounded-lg bg-slate-50 px-2.5 py-2">
              <dt className="text-slate-500">销售阶段</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{LEAD_STAGE_LABELS[suggestion.leadStage]}</dd>
            </div>
            <div className="rounded-lg bg-slate-50 px-2.5 py-2">
              <dt className="text-slate-500">下一步动作</dt>
              <dd className="mt-0.5 font-medium text-slate-900">{suggestion.nextAction}</dd>
            </div>
            <div className="rounded-lg bg-slate-50 px-2.5 py-2">
              <dt className="text-slate-500">是否转人工</dt>
              <dd className="mt-0.5 font-medium text-slate-900">
                {suggestion.needHuman ? `是（${suggestion.humanReason ?? '未说明'}）` : '否'}
              </dd>
            </div>
          </dl>

          {trace?.state?.from ? (
            <p className="mt-3 text-xs text-slate-500">
              状态流转：{LEAD_STAGE_LABELS[trace.state.from as keyof typeof LEAD_STAGE_LABELS] ?? trace.state.from}
              {' → '}
              {LEAD_STAGE_LABELS[trace.state.to as keyof typeof LEAD_STAGE_LABELS] ?? trace.state.to}
            </p>
          ) : null}

          {adjustments.length > 0 ? (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="mb-1 text-xs font-medium text-slate-600">系统对 AI 建议的修正</div>
              <ul className="space-y-1 text-[11px] text-slate-600">
                {adjustments.map((adjustment, index) => (
                  <li key={`${adjustment.rule}-${index}`}>
                    <span className="font-mono text-[10px] text-indigo-600">{adjustment.rule}</span>{' '}
                    <span className="font-medium">{adjustment.field}</span>：AI 建议「{adjustment.suggested}」→ 采纳「
                    {adjustment.adopted}」
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-400">本次没有任何系统改写（AI 建议被完整采纳）</p>
          )}
        </Section>

        {/* ---- 规则守护 + 交接策略 ---- */}
        <Section title="护栏做了什么">
          <div className="space-y-2 text-xs">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="font-medium text-slate-700">规则守护</div>
              {(trace?.guards?.violations ?? []).length === 0 ? (
                <div className="mt-0.5 text-slate-500">未发现违规（重写 {trace?.guards?.retries ?? 0} 次）</div>
              ) : (
                <ul className="mt-0.5 space-y-0.5 text-rose-700">
                  {(trace?.guards?.violations ?? []).map((violation) => (
                    <li key={violation.ruleId}>
                      {violation.ruleId}：{violation.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="font-medium text-slate-700">交接规则</div>
              <div className="mt-0.5 text-slate-500">
                {(trace?.handoff?.notes ?? []).length === 0
                  ? '未触发任何交接条件'
                  : (trace?.handoff?.notes ?? []).map((note, index) => <div key={index}>· {note}</div>)}
              </div>
            </div>

            {suggestion.ruleViolation ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                {suggestion.ruleViolation}
              </div>
            ) : null}
          </div>
        </Section>
      </div>

      {/* ---- 上下文与元数据 ---- */}
      <Section title="送进模型的上下文">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
          <span>历史消息 {trace?.context?.historyMessages ?? '—'} 条</span>
          <span>本轮新消息 {trace?.context?.newMessages ?? '—'} 条</span>
          <span>企业规则 {trace?.context?.rulesCount ?? '—'} 条</span>
          <span>交接敏感词 {trace?.context?.handoffKeywords ?? '—'} 个</span>
          {trace?.model?.finishReason ? <span>finish_reason = {trace.model.finishReason}</span> : null}
          {trace?.model?.maxTokens ? <span>max_tokens = {trace.model.maxTokens}</span> : null}
        </div>
        {suggestion.errorMessage ? (
          <div className="mt-2 break-all rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            {suggestion.errorMessage}
          </div>
        ) : null}
      </Section>

      {/* ---- 原文：模型实际收到的与实际吐出的 ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="模型收到的 prompt">
          <div className="space-y-2">
            {(rawRequest?.messages ?? []).map((message, index) => (
              <details key={index} open={index === 0} className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">
                  {message.role === 'system' ? 'system（角色 + 企业规则 + 输出契约）' : 'user（状态 + 历史 + 本轮消息）'}
                </summary>
                <pre className="prewrap max-h-96 overflow-auto border-t border-slate-100 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-700">
                  {message.content}
                </pre>
              </details>
            ))}
            {(rawRequest?.messages ?? []).length === 0 ? (
              <p className="text-xs text-slate-500">没有留存原始请求（旧版本记录）。</p>
            ) : null}
          </div>
        </Section>

        <Section title="模型的原始输出">
          <pre className="prewrap max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-700">
            {JSON.stringify(suggestion.rawResponse ?? {}, null, 2)}
          </pre>
        </Section>
      </div>

      <Section title="最终建议回复（落库内容）">
        <p className="prewrap rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-sm leading-relaxed text-slate-800">
          {suggestion.reply}
        </p>
        <div className="mt-3">
          <div className="mb-1 text-xs text-slate-500">判断依据</div>
          <p className="prewrap text-xs leading-relaxed text-slate-700">{suggestion.reason}</p>
        </div>
        {suggestion.ruleViolation || adjustments.length > 0 ? (
          <p className="mt-3 text-[11px] text-slate-500">
            注：上方为**系统采纳后**的最终结果；模型的原始输出见「模型的原始输出」一节 ——
            两者不同时，差异就是系统护栏改写的地方。
          </p>
        ) : null}
      </Section>
    </div>
  );
}
