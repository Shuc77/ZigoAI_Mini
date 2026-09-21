'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * 「首次判断进行中」的占位与轮询。
 *
 * 背景：有些客户的聊天记录并非从入口进来（种子数据、历史导入、迁移、或进程在聚合窗口期间重启），
 * 因此系统会在打开详情页时**在后台**补跑一次判断。
 * 补跑不阻塞页面渲染（否则首屏要等一次 AI 调用），所以这里负责：
 *   1) 给用户一个明确的进度提示（而不是干巴巴的"还没有 AI 判断"）；
 *   2) 轮询判断是否已生成，生成后自动刷新页面。
 *
 * 两种进入方式要分开措辞（否则又会说错话）：
 *   - BACKFILL：历史消息从没被判断过，系统正在**补跑**
 *   - IN_FLIGHT：消息已提交、模型正在跑，只是还没落库
 */
export function JudgmentPending({
  customerId,
  variant = 'BACKFILL',
  lastCustomerMessageAt = null,
}: {
  customerId: string;
  variant?: 'BACKFILL' | 'IN_FLIGHT';
  /** 最后一条客户消息的时间：判断时间晚于它，才算"我的消息被判断了" */
  lastCustomerMessageAt?: string | null;
}) {
  const router = useRouter();
  const [seconds, setSeconds] = useState(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const tick = setInterval(() => {
      if (!cancelled) setSeconds((value) => value + 1);
    }, 1000);

    const poll = setInterval(async () => {
      try {
        const response = await fetch(`/api/customers/${customerId}/suggestion`);
        if (!response.ok) return;
        const data = (await response.json()) as { suggestion?: { createdAt?: string } | null };
        if (!data.suggestion || cancelled) return;

        /*
         * 终止条件不是"出现了判断"，而是"出现了**覆盖最后一条客户消息**的判断"。
         * 页面上可能同时有两件事在跑（历史消息补跑 + 刚录入的新消息），
         * 只看"有没有判断"的话，补跑先落库就会让加载态提前消失，
         * 而新消息的判断还没回来 —— 用户以为系统没反应（真实踩到的坑）。
         */
        const covered =
          !lastCustomerMessageAt ||
          new Date(data.suggestion.createdAt ?? 0) > new Date(lastCustomerMessageAt);
        if (covered) router.refresh();
      } catch {
        /* 单次轮询失败不影响后续重试 */
      }
    }, 1000);

    // 超过 15 秒仍未出现就给一句"可以手动刷新"的兜底提示
    const slowTimer = setTimeout(() => {
      if (!cancelled) setSlow(true);
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(tick);
      clearInterval(poll);
      clearTimeout(slowTimer);
    };
  }, [customerId, router, lastCustomerMessageAt]);

  const backfill = variant === 'BACKFILL';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500" data-testid="judgment-pending">
      <div className="mb-1 flex items-center gap-2 font-medium text-slate-600">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
        {backfill ? 'AI 正在补跑历史消息的判断…' : 'AI 正在生成判断…'}
      </div>
      <p>
        {backfill
          ? '这个客户此前有客户消息从未被判断过（演示数据直接写库、历史导入或数据迁移都会这样），系统正在补跑一次判断。刚录入的新消息会单独再判断一次。'
          : '客户消息已进入本轮判断，模型正在生成结果。'}
        通常几秒内自动出现，页面会自动刷新，无需手动刷新。
      </p>
      {seconds > 0 ? <p className="mt-1 text-[11px] text-slate-400">已等待 {seconds} 秒</p> : null}
      {slow ? (
        <p className="mt-1 text-[11px] text-amber-600">
          用时较长（模型响应变慢或调用失败）。判断失败时系统会给出「已降级为人工」的结果，也可以稍后手动刷新。
        </p>
      ) : null}
    </div>
  );
}
