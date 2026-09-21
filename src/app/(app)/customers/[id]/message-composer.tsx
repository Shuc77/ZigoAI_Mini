'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import {
  DEFAULT_BATCH_WINDOW_MS,
  describeBatchWindow,
  type BatchWindowReason,
} from '@/lib/agent/batch-window';
import { newClientId } from '@/lib/uuid';

/**
 * "客户发来消息"的录入框。
 *
 * 真实微信接入不在本次范围，但我们仍按**真实入口的语义**实现：
 *  - 每条消息带客户端生成的 clientMessageId（幂等键），网络重试/连点不会产生重复消息；
 *  - 提交失败时**保留同一个 clientMessageId**，用户重试仍是同一条消息；
 *  - 提交成功后清空，下一条消息用新的 id。
 *
 * 与"连续消息合并"的配合（这里踩过一次真实的坑）：
 *   发消息接口在窗口期内只入队、不判断，所以"提交成功"和"AI 判断完成"是两件事。
 *   **提交只等待 POST 本身（几十毫秒），轮询放到后台** —— 否则输入框会在整个等待期间被锁死，
 *   而"客户连发多条消息"恰好是连续消息合并要演示的场景，锁死输入框等于把功能演示废掉。
 */
export function MessageComposer({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [clientMessageId, setClientMessageId] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 待判断的批次（可能同时有多批：客户连发时它们通常合并成一批） */
  const pendingBatchesRef = useRef<Set<string>>(new Set());
  const pollingRef = useRef(false);

  /**
   * 后台轮询：不阻塞输入，直到所有待判断批次都产出了建议。
   * 之所以要轮询而不是让接口同步返回：聚合窗口要等"客户是否还在继续发言"。
   *
   * 间隔 1 秒 —— 窗口本身已经压到 2–3 秒，轮询间隔如果还是 1.5 秒，
   * 等于把好不容易省下来的时间又还回去了（判断好了却要等下一次轮询才显示）。
   */
  async function pollPendingBatches(windowMs: number) {
    if (pollingRef.current) return;
    pollingRef.current = true;

    const deadline = Date.now() + Math.max(120_000, windowMs * 6);

    try {
      while (pendingBatchesRef.current.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        for (const batchId of [...pendingBatchesRef.current]) {
          try {
            const response = await fetch(
              `/api/customers/${customerId}/suggestion?batchId=${encodeURIComponent(batchId)}`,
            );
            if (!response.ok) continue;
            const data = (await response.json()) as {
              suggestion?: unknown;
              batchMessageCount?: number | null;
            };
            if (data.suggestion) {
              pendingBatchesRef.current.delete(batchId);
              const count = data.batchMessageCount ?? 1;
              setNotice(
                count > 1
                  ? `AI 已把本轮客户连发的 ${count} 条消息合并判断完成`
                  : 'AI 判断已完成',
              );
              router.refresh();
            }
          } catch {
            /* 单次轮询失败不影响其它批次，继续重试直到超时 */
          }
        }
      }

      if (pendingBatchesRef.current.size > 0) {
        setNotice('AI 判断仍在进行，可稍后刷新页面查看');
        router.refresh();
      }
    } finally {
      pollingRef.current = false;
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = content.trim();
    if (!text || pending) return;

    setPending(true);
    setError(null);
    setNotice(null);

    // 失败重试时复用同一个幂等键
    const id = clientMessageId || newClientId();

    try {
      const response = await fetch(`/api/customers/${customerId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, clientMessageId: id }),
      });
      const data = (await response.json()) as {
        message?: string;
        deduplicated?: boolean;
        pending?: boolean;
        batchId?: string;
        batchWindowMs?: number;
        batchWindowReason?: BatchWindowReason;
        batchMessageCount?: number;
      };

      if (!response.ok) {
        setClientMessageId(id);
        setError(data.message ?? '发送失败');
        return;
      }

      setClientMessageId('');
      setContent('');

      if (data.deduplicated) {
        setNotice('检测到重复提交，已按同一条消息处理（未重复落库）');
        router.refresh();
        return;
      }

      router.refresh();

      if (data.pending && data.batchId) {
        // 关键：**不在这里等待**。提交只等上面这个 POST（几十毫秒），
        // 轮询交给后台，输入框立刻恢复可用 —— 客户连发多条消息才演示得出来。
        pendingBatchesRef.current.add(data.batchId);
        // 界面显示**服务端刚算出来的真实窗口**，而不是写死的 8 秒：
        // 客户问了一句就 2 秒，客户在补充说明就 3 秒，客户只是陈述才等 8 秒。
        const windowMs = data.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
        const reason = data.batchWindowReason ?? 'STATEMENT';
        const seconds = Math.max(1, Math.round(windowMs / 1000));
        setNotice(
          `已收到消息，${describeBatchWindow(reason)} —— 约 ${seconds} 秒后统一判断` +
            `（客户继续发言会自动顺延，判断好之后自动出现）`,
        );
        void pollPendingBatches(windowMs);
      }
    } catch {
      setClientMessageId(id);
      setError('网络异常，可直接重试（同一条消息不会重复入库）');
    } finally {
      // 注意：这里只解除"提交中"状态，与 AI 判断是否完成无关
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        data-testid="customer-composer"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={3}
        placeholder="输入一条客户消息（模拟微信收到），例如：你们周末有课吗？"
        className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            void submit(event as unknown as React.FormEvent);
          }
        }}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">⌘/Ctrl + Enter 发送 · 消息真实入库并参与下一轮 AI 判断</p>
        <button
          type="submit"
          data-testid="customer-send"
          disabled={pending || content.trim().length === 0}
          className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? '发送中…' : '模拟客户发来'}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}
      {notice ? (
        <div
          data-testid="composer-notice"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700"
        >
          {notice}
        </div>
      ) : null}
    </form>
  );
}
