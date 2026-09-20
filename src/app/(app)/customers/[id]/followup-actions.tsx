'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Follow-up 演示与状态区。
 *
 * 真实阈值是分钟级，演示时不可能真等 —— 所以这里提供两个按钮：
 *   ① 「模拟静默 N 分钟」：把客户最后发言时间往前拨，立刻满足"静默超时"条件
 *   ② 「立即扫描跟进」：跑一次跟进判定，满足条件就生成跟进建议（复用同一条 pipeline）
 *
 * 同时把**判定结论与理由**显示出来（例如"销售已在客户之后回过话，球在客户那边"），
 * 让"为什么还不跟进"这件事也可解释，而不是一个黑盒。
 */
export function FollowupActions({
  customerId,
  decision,
}: {
  customerId: string;
  decision: { shouldFollowUp: boolean; rule: string; reason: string } | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: 'SCAN' | 'TIME_TRAVEL', minutes?: number) {
    setPending(action);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/customers/${customerId}/followup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, minutes }),
      });
      const data = (await response.json()) as {
        message?: string;
        followed?: boolean;
        decision?: { reason: string };
      };
      if (!response.ok) {
        setError(data.message ?? '操作失败');
        return;
      }

      if (action === 'TIME_TRAVEL') {
        setMessage(data.message ?? '已模拟时间流逝');
      } else {
        setMessage(
          data.followed
            ? '已生成跟进建议，见右侧 AI 判断卡片'
            : `本次未触发跟进：${data.decision?.reason ?? '不满足条件'}`,
        );
      }
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setPending(null);
    }
  }

  const buttonBase =
    'rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition disabled:opacity-50';

  return (
    <div className="space-y-2 border-t border-slate-100 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-slate-500">跟进（Follow-up）</span>
        {decision ? (
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] ${
              decision.shouldFollowUp
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-slate-200 bg-slate-50 text-slate-500'
            }`}
          >
            {decision.shouldFollowUp ? '满足跟进条件' : '暂不跟进'}
          </span>
        ) : null}
      </div>

      {decision ? <p className="text-[11px] leading-relaxed text-slate-500">{decision.reason}</p> : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void call('TIME_TRAVEL', 30)}
          className={`${buttonBase} border-slate-200 bg-white text-slate-600 hover:border-slate-300`}
          title="演示用：把客户最后发言时间往前拨 30 分钟，立刻复现'客户静默超时'"
        >
          {pending === 'TIME_TRAVEL' ? '模拟中…' : '模拟静默 30 分钟'}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void call('SCAN')}
          className={`${buttonBase} border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100`}
        >
          {pending === 'SCAN' ? '扫描中…' : '立即扫描跟进'}
        </button>
      </div>

      {message ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          {error}
        </div>
      ) : null}
    </div>
  );
}
