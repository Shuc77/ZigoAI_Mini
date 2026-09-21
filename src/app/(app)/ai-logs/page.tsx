import Link from 'next/link';

import { formatDateTime, formatRelative } from '@/lib/format';
import { LEAD_STAGE_LABELS } from '@/lib/types';
import { requirePageAuth } from '@/server/auth';
import { listRecentAiCalls, summarizeAdoption, summarizeAiCost } from '@/server/repositories/suggestions';

export const metadata = { title: 'AI 日志 · ZigoAI Mini' };

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  SUCCESS: { label: '成功', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  RETRY_OK: { label: '重试后成功', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  FALLBACK: { label: '已降级', className: 'border-amber-200 bg-amber-50 text-amber-700' },
  ERROR: { label: '失败', className: 'border-rose-200 bg-rose-50 text-rose-700' },
};

const TRIGGER_LABELS: Record<string, string> = {
  NEW_MESSAGE: '客户新消息',
  REGENERATE: '重新生成',
  FOLLOW_UP: '跟进',
  INITIAL_BACKFILL: '首次判断补跑',
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 把可能很长、可能重复的错误信息压成一句话。
 *
 * 为什么要压：`errorMessage` 是**每次尝试**的错误用 ` | ` 拼起来的，
 * 所以"重试 1 次"的记录里同一类错误会出现两遍（例如 `http_error: insufficient Balance | http_error: …`）。
 * 表格里塞不下也没必要 —— 完整信息在链路页（那里有原始响应与每一次尝试）。
 */
const ERROR_LABELS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /insufficient\s*balance|余额不足/i, label: '账户余额不足' },
  { pattern: /truncated|max_tokens/i, label: '输出被截断（已加大预算重试）' },
  { pattern: /timeout|超时/i, label: '调用超时' },
  { pattern: /empty_content|空内容/i, label: '模型返回空内容' },
  { pattern: /bad_response|不是合法 ?json/i, label: '响应格式异常' },
  { pattern: /network_error|网络/i, label: '网络错误' },
  { pattern: /http_error|HTTP/i, label: '接口返回错误' },
  { pattern: /schema/i, label: '输出结构不符合要求' },
];

function shortError(message: string): string {
  const hit = ERROR_LABELS.find((item) => item.pattern.test(message));
  return hit ? hit.label : message.split('|')[0].trim().slice(0, 40);
}

export default async function AiLogsPage() {
  const ctx = await requirePageAuth();
  const [calls, cost, adoption] = await Promise.all([
    listRecentAiCalls(ctx, 50),
    summarizeAiCost(ctx),
    summarizeAdoption(ctx),
  ]);

  const cards = [
    { label: 'AI 调用次数', value: String(cost.calls), hint: '本企业累计' },
    {
      label: 'Token 消耗',
      value: `${(cost.promptTokens + cost.completionTokens).toLocaleString('zh-CN')}`,
      hint: `输入 ${cost.promptTokens.toLocaleString('zh-CN')} / 输出 ${cost.completionTokens.toLocaleString('zh-CN')}`,
    },
    {
      label: '估算成本',
      value: `¥${cost.estimatedCostCny.toFixed(4)}`,
      hint: '按 .env 里的单价常数计算',
    },
    {
      label: '降级 / 失败次数',
      value: String(cost.fallbackCount),
      hint: 'AI 不可用时自动转人工，不影响业务',
    },
    {
      label: '建议采纳率',
      value: percent(adoption.acceptanceRate),
      hint: `已发送 ${adoption.sent} 条，其中原文直接发出 ${adoption.acceptedUnchanged} 条`,
    },
    {
      label: '人工修改率',
      value: percent(adoption.modificationRate),
      hint: `被销售改写 ${adoption.modified} 条，改写越多说明建议越不贴业务`,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">AI 日志</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          每一次 AI 判断都留下了原始请求、原始响应、耗时、token 与失败原因 —— 线上出问题可以回放到具体某一次调用，
          而不是靠猜。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{card.label}</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{card.value}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">{card.hint}</div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-medium">最近 50 次调用</h2>
          <span className="text-xs text-slate-400">按时间倒序</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">客户</th>
                <th className="px-3 py-2 font-medium">触发</th>
                <th className="px-3 py-2 font-medium">意图 / 阶段 / 动作</th>
                <th className="px-3 py-2 font-medium">人工</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">模型</th>
                <th className="px-3 py-2 font-medium">耗时</th>
                <th className="px-3 py-2 font-medium">Tokens</th>
                <th className="px-3 py-2 font-medium">成本</th>
                <th className="px-3 py-2 font-medium">规则守护</th>
                <th className="px-3 py-2 font-medium">链路</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {calls.map((call) => {
                const status = STATUS_LABELS[call.status] ?? STATUS_LABELS.SUCCESS;
                return (
                  <tr key={call.id} className="align-top transition hover:bg-slate-50/70">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                      {formatDateTime(call.createdAt)}
                      <div className="text-[10px] text-slate-400">{formatRelative(call.createdAt)}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-700">{call.customer.name}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                      {TRIGGER_LABELS[call.trigger] ?? call.trigger}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {call.customerIntent} · {LEAD_STAGE_LABELS[call.leadStage]} · {call.nextAction}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {call.needHuman ? <span className="text-orange-600">是</span> : <span className="text-slate-400">否</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`rounded-full border px-1.5 py-0.5 ${status.className}`}>{status.label}</span>
                      {call.retryCount > 0 ? (
                        <span className="ml-1 text-[10px] text-slate-400">重试 {call.retryCount}</span>
                      ) : null}
                      {call.errorMessage ? (
                        <div className="mt-1 max-w-[220px] text-[10px] text-rose-500" title={call.errorMessage}>
                          {/* 列表里只给一句话摘要，完整错误放链路页（那里本来就有原文与每一次尝试） */}
                          {shortError(call.errorMessage)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                      {call.model}
                      <div className="text-[10px] text-slate-400">prompt {call.promptVersion}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                      {call.latencyMs !== null ? `${call.latencyMs}ms` : '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                      {call.promptTokens !== null ? `${call.promptTokens}+${call.completionTokens ?? 0}` : '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                      {/* 单价未配置时不能显示 ¥0.0000 —— 那看起来像"不花钱"，实际是"没算" */}
                      {cost.estimatedCostCny > 0 ? (
                        `¥${(call.estimatedCostCny ?? 0).toFixed(4)}`
                      ) : (
                        <span className="text-slate-400" title="在 .env 里配置 DEEPSEEK_PRICE_IN_PER_MTOK / _OUT_ 后即可算出金额">
                          未配置单价
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      {call.ruleViolation ? (
                        <span className="text-rose-600" title={call.ruleViolation}>
                          违规
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Link
                        href={`/ai-logs/${call.id}`}
                        className="font-medium text-indigo-600 hover:text-indigo-700"
                      >
                        查看链路 →
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {calls.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-3 py-10 text-center text-sm text-slate-400">
                    还没有 AI 调用记录
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
        <div className="mb-1 font-medium text-slate-600">这张表怎么用来排障</div>
        <ul className="list-inside list-disc space-y-0.5">
          <li>状态列出现「已降级」：说明那次 AI 调用失败，系统按兜底话术转人工 —— 点开 `AiSuggestion.errorMessage` 能看到具体原因</li>
          <li>耗时异常高：多半是输出被截断后放大了 `max_tokens` 重试（见「重试 n」标记）</li>
          <li>
            「耗时」列记录的是**模型真实耗时**（响应体读完才计时）。想知道时间具体花在哪 ——
            窗口、模型生成、还是落库 —— 点每一行的「查看链路 →」，那里有分段耗时与完整原文
          </li>
          <li>「人工修改率」偏高：不是 bug，而是产品信号 —— 说明建议不贴业务，应该回到企业规则页补规则或补示例</li>
        </ul>
      </div>
    </div>
  );
}
