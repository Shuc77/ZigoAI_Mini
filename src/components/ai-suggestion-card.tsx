import type { AiSuggestion } from '@/generated/prisma/client';
import { formatDateTime } from '@/lib/format';
import { LEAD_STAGE_LABELS, type TenantRules } from '@/lib/types';
import { parseAdjustments } from '@/lib/agent/state';

/**
 * AI 判断卡片：把"模型说了什么"和"系统采纳了什么"分开呈现。
 *
 * ## 信息架构（一次真实的可用性返工）
 *
 * 原版把意图/阶段/动作/依据/规则/修正/token/耗时平铺在一张卡上，销售要读完一大段分析
 * 才知道"我该不该发这句话"。但销售的决策其实只有两个：**这句发不发**、**要不要人来**。
 * 其余信息是给主管和开发者看的（审计、排障、答辩）。
 *
 * 所以现在分两层：
 *   - **主区域（销售的视线）**：需不需要人 → 一行结论摘要 → 建议回复 + 发送按钮
 *   - **折叠区「为什么这么判断？」（想深究的人点开）**：依据、规则、系统修正、审计字段
 *
 * 折叠用的是原生 `<details>`：服务端渲染、无 JS 状态、键盘可用 —— 演示时点一下就能展开，
 * 不需要额外的交互代码。
 */

/**
 * 徽章描述的是**这次 AI 调用本身的健康度**，不是"判断对不对"。
 * （早期版本把它写成"正常"，会让人误以为在评价判断质量 —— 措辞必须说清边界。）
 */
const STATUS_STYLES: Record<string, { label: string; className: string; hint: string }> = {
  SUCCESS: { label: '调用成功', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', hint: '本次 AI 调用一次成功（不代表判断一定正确，判断质量请看下方依据）' },
  RETRY_OK: { label: '重试后成功', className: 'border-sky-200 bg-sky-50 text-sky-700', hint: '首次调用不合格，带错误信息重试后成功' },
  FALLBACK: { label: '已降级为人工', className: 'border-amber-200 bg-amber-50 text-amber-700', hint: 'AI 未能给出有效判断，已自动降级为人工跟进' },
  ERROR: { label: '调用失败', className: 'border-rose-200 bg-rose-50 text-rose-700', hint: 'AI 调用失败' },
};

/** 判断是怎么被触发的 —— 它决定这段话该不该信任、以及"为什么现在是它" */
const TRIGGER_LABELS: Record<string, string> = {
  NEW_MESSAGE: '客户发来新消息',
  REGENERATE: '销售手动重新判断',
  FOLLOW_UP: '客户静默超时，系统主动跟进',
  INITIAL_BACKFILL: '首次判断补跑（历史消息此前没被判断过）',
};

export function AiSuggestionCard({
  suggestion,
  rules,
  actions,
  waitingForCustomer = false,
  batchMessageCount = null,
  pending,
}: {
  suggestion: AiSuggestion | null;
  rules: TenantRules;
  /** M3 起注入"编辑回复 / 发送 / 重新生成"等交互 */
  actions?: React.ReactNode;
  /**
   * 已按建议回复客户、且客户之后还没再说话 —— 由"最后一条销售消息晚于最后一条客户消息"推导。
   * 这是**派生状态**，不额外调用 AI：销售回完话之后，判断对象（客户）并没有新证据，
   * 真正需要的是让销售知道"现在轮到客户了"。
   */
  waitingForCustomer?: boolean;
  /** 本轮合并了多少条客户消息（连续消息合并的可见证据） */
  batchMessageCount?: number | null;
  /** 系统正在后台补跑"首次判断"时要展示的加载态（避免出现"还没有 AI 判断"这种误导） */
  pending?: React.ReactNode;
}) {
  if (!suggestion) {
    if (pending) return <>{pending}</>;
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

  // AI 原始建议 vs 系统采纳：把落差就地展示，避免"看起来自相矛盾"
  const stageAdjustment = adjustments.find((a) => a.field === 'lead_stage');

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-medium">AI 判断</h2>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.className}`} title={status.hint}>
          {status.label}
        </span>
      </div>

      {/* ---------------- 主区域：销售只需要看这一块 ---------------- */}
      <div className="space-y-3 px-4 py-3">
        {suggestion.needHuman ? (
          <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
            <span className="font-medium">建议人工介入</span>
            {suggestion.humanReason ? <span>：{suggestion.humanReason}</span> : null}
          </div>
        ) : null}

        {waitingForCustomer ? (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            <span className="font-medium">已回复客户，正在等待客户回应。</span>
            客户再发消息时会自动重新判断；若长时间无回应，系统会在 Follow-up 中提示跟进。
          </div>
        ) : null}

        {/* 一行说清"系统读懂了什么"：三个关键结论，不占地方但随时可见 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span>
            客户意图 <span className="font-medium text-slate-900">{suggestion.customerIntent}</span>
          </span>
          <span className="text-slate-300">|</span>
          <span>
            阶段{' '}
            <span className="font-medium text-slate-900">{LEAD_STAGE_LABELS[suggestion.leadStage]}</span>
          </span>
          <span className="text-slate-300">|</span>
          <span>
            下一步 <span className="font-medium text-slate-900">{suggestion.nextAction}</span>
          </span>
          {stageAdjustment ? (
            <span className="text-[11px] text-amber-700">（AI 原建议的阶段被系统拦住）</span>
          ) : null}
        </div>

        {suggestion.trigger === 'INITIAL_BACKFILL' ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            这条判断基于该客户此前的 <span className="font-medium">{batchMessageCount ?? 1}</span> 条历史消息
            —— 系统发现这些消息还没有被判断过（例如来自导入、迁移或演示数据），自动补跑了一次。
          </div>
        ) : batchMessageCount !== null && batchMessageCount > 1 ? (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800">
            本轮把客户连续发送的 <span className="font-medium">{batchMessageCount}</span> 条消息
            <span className="font-medium">合并为一次判断</span>（否则会连续回复 {batchMessageCount} 次）
          </div>
        ) : null}

        {suggestion.status === 'FALLBACK' || suggestion.status === 'ERROR' ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <div className="font-medium">AI 本次未能给出有效判断，已自动降级为人工跟进</div>
            {suggestion.errorMessage ? (
              <div className="mt-1 break-all text-[11px] text-amber-700">{suggestion.errorMessage}</div>
            ) : null}
          </div>
        ) : null}

        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <span>建议回复</span>
            {suggestion.sentMessageId ? (
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                {suggestion.finalReply === suggestion.reply ? '已按建议发送' : '已修改后发送'}
              </span>
            ) : null}
          </div>
          <div
            data-testid="suggestion-reply-text"
            className="prewrap rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5 text-[15px] leading-relaxed text-slate-900"
          >
            {suggestion.reply}
          </div>
        </div>

        {/* 发送 / 改一下再发 / 重新生成 —— 紧贴建议回复，销售不用找 */}
        {actions}
      </div>

      {/* ---------------- 折叠区：想深究的人点开 ---------------- */}
      <details className="group border-t border-slate-100">
        <summary
          data-testid="suggestion-why"
          className="cursor-pointer list-none px-4 py-2.5 text-xs text-slate-500 hover:bg-slate-50 hover:text-slate-700"
        >
          <span className="inline-block transition group-open:rotate-90">▸</span> 为什么这么判断？（依据 / 企业规则 /
          系统修正 / 审计信息）
        </summary>

        <div className="space-y-3 border-t border-slate-100 px-4 py-3 text-sm">
          <div className="text-[11px] text-slate-500">
            判断来源：{TRIGGER_LABELS[suggestion.trigger] ?? suggestion.trigger}
          </div>

          <div>
            <div className="mb-1 text-xs text-slate-500">判断依据</div>
            <p className="prewrap text-xs leading-relaxed text-slate-700">{suggestion.reason}</p>
          </div>

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

          {suggestion.sentMessageId && suggestion.finalReply && suggestion.finalReply !== suggestion.reply ? (
            <div>
              <div className="mb-1 text-xs text-slate-500">销售实际发送</div>
              <div className="prewrap rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-sm leading-relaxed text-slate-800">
                {suggestion.finalReply}
              </div>
            </div>
          ) : null}

          {suggestion.ruleViolation ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              规则守护提示：{suggestion.ruleViolation}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span>{formatDateTime(suggestion.createdAt)}</span>
            <span>{suggestion.model}</span>
            {suggestion.latencyMs !== null ? <span>模型耗时 {suggestion.latencyMs}ms</span> : null}
            {suggestion.promptTokens !== null ? (
              <span>
                tokens {suggestion.promptTokens}+{suggestion.completionTokens ?? 0}
              </span>
            ) : null}
            <span>prompt {suggestion.promptVersion}</span>
          </div>

          {/* 从"销售看到的结论"通向"这次判断的完整链路"——审计信息不该挤占销售视线，但必须够得着 */}
          <a
            href={`/ai-logs/${suggestion.id}`}
            className="inline-block text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
          >
            查看这次判断的完整链路（分段耗时 / 送进模型的原文 / 模型原始输出）→
          </a>
        </div>
      </details>
    </div>
  );
}
