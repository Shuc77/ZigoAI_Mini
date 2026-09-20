import type { AiSuggestion } from '@/generated/prisma/client';
import { formatDateTime } from '@/lib/format';
import { LEAD_STAGE_LABELS, type TenantRules } from '@/lib/types';
import { parseAdjustments } from '@/lib/agent/state';

/**
 * AI 判断卡片：把"模型说了什么"和"系统采纳了什么"分开呈现。
 * 这张卡片是整个产品的核心界面 —— 销售看到的是判断 + 理由 + 可直接发送的话。
 */

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  SUCCESS: { label: '正常', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  RETRY_OK: { label: '重试后成功', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  FALLBACK: { label: '已降级为人工', className: 'border-amber-200 bg-amber-50 text-amber-700' },
  ERROR: { label: '调用失败', className: 'border-rose-200 bg-rose-50 text-rose-700' },
};

export function AiSuggestionCard({
  suggestion,
  rules,
  actions,
}: {
  suggestion: AiSuggestion | null;
  rules: TenantRules;
  /** M3 起注入"编辑回复 / 发送 / 重新生成"等交互 */
  actions?: React.ReactNode;
}) {
  if (!suggestion) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-4 text-xs text-slate-500">
        <div className="mb-1 font-medium text-slate-600">AI 判断卡片</div>
        还没有 AI 判断。录入一条客户消息后，AI 会给出意图、阶段、下一步动作与建议回复。
      </div>
    );
  }

  const status = STATUS_STYLES[suggestion.status] ?? STATUS_STYLES.SUCCESS;
  const rulesApplied = Array.isArray(suggestion.rulesApplied)
    ? (suggestion.rulesApplied as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  const adjustments = parseAdjustments(suggestion.stateAdjustments);
  const ruleById = new Map(rules.map((rule) => [rule.id, rule.text]));

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-medium">AI 判断</h2>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.className}`}>
          {status.label}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3 text-sm">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
          <span>{formatDateTime(suggestion.createdAt)}</span>
          <span>{suggestion.model}</span>
          {suggestion.latencyMs !== null ? <span>{suggestion.latencyMs}ms</span> : null}
          {suggestion.promptTokens !== null ? (
            <span>
              tokens {suggestion.promptTokens}+{suggestion.completionTokens ?? 0}
            </span>
          ) : null}
          <span>prompt {suggestion.promptVersion}</span>
        </div>

        {suggestion.status === 'FALLBACK' || suggestion.status === 'ERROR' ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <div className="font-medium">AI 本次未能给出有效判断，已自动降级为人工跟进</div>
            {suggestion.errorMessage ? (
              <div className="mt-1 break-all text-[11px] text-amber-700">{suggestion.errorMessage}</div>
            ) : null}
          </div>
        ) : null}

        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg bg-slate-50 px-2.5 py-2">
            <dt className="text-slate-500">客户意图</dt>
            <dd className="mt-0.5 font-medium text-slate-900">
              {suggestion.customerIntent}
              {suggestion.intentDetail ? (
                <span className="ml-1 font-normal text-slate-500">· {suggestion.intentDetail}</span>
              ) : null}
            </dd>
          </div>
          <div className="rounded-lg bg-slate-50 px-2.5 py-2">
            <dt className="text-slate-500">销售阶段</dt>
            <dd className="mt-0.5 font-medium text-slate-900">
              {LEAD_STAGE_LABELS[suggestion.leadStage]}
            </dd>
          </div>
          <div className="rounded-lg bg-slate-50 px-2.5 py-2">
            <dt className="text-slate-500">下一步动作</dt>
            <dd className="mt-0.5 font-medium text-slate-900">{suggestion.nextAction}</dd>
          </div>
        </dl>

        {rulesApplied.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-500">引用企业规则：</span>
            {rulesApplied.map((id) => (
              <span
                key={id}
                title={ruleById.get(id) ?? '未找到该规则'}
                className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700"
              >
                {id}
              </span>
            ))}
          </div>
        ) : null}

        {suggestion.needHuman ? (
          <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
            <span className="font-medium">建议人工介入</span>
            {suggestion.humanReason ? <span>：{suggestion.humanReason}</span> : null}
          </div>
        ) : null}

        <div>
          <div className="mb-1 text-xs text-slate-500">判断依据</div>
          <p className="prewrap text-xs leading-relaxed text-slate-700">{suggestion.reason}</p>
        </div>

        <div>
          <div className="mb-1 text-xs text-slate-500">建议回复</div>
          <div className="prewrap rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-sm leading-relaxed text-slate-800">
            {suggestion.reply}
          </div>
        </div>

        {adjustments.length > 0 ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="mb-1 text-xs font-medium text-slate-600">系统对 AI 建议的修正</div>
            <ul className="space-y-1 text-[11px] text-slate-600">
              {adjustments.map((adjustment, index) => (
                <li key={`${adjustment.rule}-${index}`}>
                  <span className="font-medium">{adjustment.field}</span>：AI 建议「{adjustment.suggested}」→
                  采纳「{adjustment.adopted}」（{adjustment.note}）
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {suggestion.ruleViolation ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            规则守护提示：{suggestion.ruleViolation}
          </div>
        ) : null}

        {actions}
      </div>
    </div>
  );
}
