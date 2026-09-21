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
 *
 * 确认方式：终态变更走**应用内联确认**（点一下按钮 → 就地变成"确认 / 取消"），
 * 而不是 `window.confirm` —— 原生弹窗样式无法控制、会打断整个页面观感，
 * 而且它的措辞和按钮文案也改不了（"确定/取消"说不清后果）。
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
  /** 待确认的终态操作：先问清楚，再提交 */
  const [confirming, setConfirming] = useState<null | { action: string; label: string }>(null);

  const isTerminal = leadStage === 'WON' || leadStage === 'LOST';

  async function act(action: string, label: string) {
    setPending(action);
    setError(null);
    setConfirming(null);
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

      {confirming ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-amber-800">
            确认把该客户标记为「<span className="font-medium">{confirming.label}</span>」吗？
            终态变更只能人工操作，标记后 AI 不会再改动它（可用「撤销终态」恢复）。
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void act(confirming.action, confirming.label)}
              className={`${buttonBase} border-amber-300 bg-amber-500 text-white hover:bg-amber-600`}
            >
              {pending ? '提交中…' : `确认标记为${confirming.label}`}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => setConfirming(null)}
              className={`${buttonBase} border-slate-200 bg-white text-slate-600 hover:border-slate-300`}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
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
                onClick={() => setConfirming({ action: 'CONFIRM_WON', label: '已成交' })}
                className={`${buttonBase} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}
              >
                确认成交
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => setConfirming({ action: 'CONFIRM_LOST', label: '已流失' })}
                className={`${buttonBase} border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100`}
              >
                确认流失
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
      )}

      {error ? <div className="text-[11px] text-red-600">{error}</div> : null}
    </div>
  );
}
