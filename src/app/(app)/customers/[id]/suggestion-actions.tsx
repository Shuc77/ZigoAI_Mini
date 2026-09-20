'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * 销售侧操作区（核心任务 4）。
 *
 * 三个动作：
 *   1) 发送给客户 —— 可以把 AI 建议改完再发，发出去的文本真实入库并参与下一轮判断
 *   2) 重新生成   —— 不产生新消息，只让 AI 重判一次
 *   3) Pro 重判   —— 换用更强的模型，用于对比质量与成本（AI 日志页可见差异）
 *
 * 关键产品语义：**发出去的是人确认过的文本，不是 AI 的原始输出**。
 * 建议上会留痕 sentMessageId / finalReply，因此"AI 建议 → 人工修改 → 实际发送"三段可追溯。
 */
export function SuggestionActions({
  suggestionId,
  originalReply,
  alreadySent,
  sentFinalReply,
}: {
  suggestionId: string;
  originalReply: string;
  alreadySent: boolean;
  sentFinalReply: string | null;
}) {
  const router = useRouter();
  const [reply, setReply] = useState(sentFinalReply ?? originalReply);
  const [pending, setPending] = useState<null | 'send' | 'regen' | 'pro'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const edited = reply.trim() !== originalReply.trim();

  async function call(kind: 'send' | 'regen' | 'pro') {
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      if (kind === 'send') {
        const response = await fetch(`/api/suggestions/${suggestionId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply }),
        });
        const data = (await response.json()) as { message?: string; edited?: boolean };
        if (!response.ok) {
          setError(data.message ?? '发送失败');
          return;
        }
        setNotice(data.edited ? '已发送（销售修改过 AI 建议，修改留痕已记录）' : '已发送 AI 建议原文');
        router.refresh();
        return;
      }

      const response = await fetch(`/api/suggestions/${suggestionId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useProModel: kind === 'pro' }),
      });
      const data = (await response.json()) as { message?: string; status?: string };
      if (!response.ok) {
        setError(data.message ?? '重新生成失败');
        return;
      }
      setNotice(
        kind === 'pro'
          ? `已用更强模型重判（${data.status === 'FALLBACK' ? '本次降级为人工' : '成功'}）`
          : '已重新生成建议',
      );
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setPending(null);
    }
  }

  const buttonBase =
    'rounded-lg px-3 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-700">发送给客户</span>
        {alreadySent ? (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
            已发送
          </span>
        ) : null}
      </div>

      <textarea
        data-testid="suggestion-reply"
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        rows={4}
        className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm leading-relaxed outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      />

      {edited ? (
        <button
          type="button"
          onClick={() => setReply(originalReply)}
          className="text-[11px] text-slate-500 underline-offset-2 hover:text-indigo-600 hover:underline"
        >
          已修改 · 点此恢复 AI 原文
        </button>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="suggestion-send"
          disabled={pending !== null || reply.trim().length === 0}
          onClick={() => void call('send')}
          className={`${buttonBase} bg-indigo-600 text-white hover:bg-indigo-700`}
        >
          {pending === 'send' ? '发送中…' : alreadySent ? '再次发送' : '发送'}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void call('regen')}
          className={`${buttonBase} border border-slate-200 bg-white text-slate-600 hover:border-slate-300`}
        >
          {pending === 'regen' ? '生成中…' : '重新生成'}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void call('pro')}
          title="使用 deepseek-v4-pro 重新判断，对比质量与成本"
          className={`${buttonBase} border border-slate-200 bg-white text-slate-600 hover:border-slate-300`}
        >
          {pending === 'pro' ? '重判中…' : 'Pro 重判'}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
