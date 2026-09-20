'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { LeadStage } from '@/generated/prisma/enums';

/**
 * 人工状态操作。
 *
 * 为什么需要：状态机把三件事锁给了人（终态不可由 AI 改动、阶段不回退、需人工只升不降），
 * 所以必须提供"人来解除"的入口，否则客户会永远卡在"需人工"里。
 * 这一小块 UI 就是"AI 提建议、人做决定"的可见边界。
 */
export function StateActions({
  customerId,
  needHuman,
  leadStage,
}: {
  customerId: string;
  needHuman: boolean;
  leadStage: LeadStage;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isTerminal = leadStage === 'WON' || leadStage === 'LOST';

  async function act(action: string, label: string) {
    if (action === 'CONFIRM_WON' || action === 'CONFIRM_LOST') {
      const confirmed = window.confirm(`确认要标记为「${label}」吗？终态变更只能人工操作。`);
      if (!confirmed) return;
    }

    setPending(action);
    setError(null);
    try {
      const response = await fetch(`/api/customers/${customerId}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(data.message ?? '操作失败');
        return;
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
      <div className="text-[11px] font-medium text-slate-500">人工操作（AI 无权执行）</div>
      <div className="flex flex-wrap gap-2">
        {needHuman ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void act('RESOLVE_HUMAN', '已处理')}
            className={`${buttonBase} border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100`}
          >
            {pending === 'RESOLVE_HUMAN' ? '处理中…' : '标记人工已处理'}
          </button>
        ) : null}

        {!isTerminal ? (
          <>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void act('CONFIRM_WON', '已成交')}
              className={`${buttonBase} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}
            >
              {pending === 'CONFIRM_WON' ? '提交中…' : '确认成交'}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void act('CONFIRM_LOST', '已流失')}
              className={`${buttonBase} border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100`}
            >
              {pending === 'CONFIRM_LOST' ? '提交中…' : '确认流失'}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void act('REOPEN', '重新激活')}
            className={`${buttonBase} border-slate-200 bg-white text-slate-600 hover:border-slate-300`}
          >
            {pending === 'REOPEN' ? '提交中…' : '撤销终态（重新激活）'}
          </button>
        )}
      </div>
      {error ? <div className="text-[11px] text-red-600">{error}</div> : null}
    </div>
  );
}
