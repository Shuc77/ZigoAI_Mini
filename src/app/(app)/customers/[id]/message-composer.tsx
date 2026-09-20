'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { newClientId } from '@/lib/uuid';

/**
 * "客户发来消息"的录入框。
 *
 * 真实微信接入不在本次范围，但我们仍按**真实入口的语义**实现：
 *  - 每条消息带客户端生成的 clientMessageId（幂等键），网络重试/连点不会产生重复消息；
 *  - 提交失败时**保留同一个 clientMessageId**，用户重试仍是同一条消息；
 *  - 提交成功后清空，下一条消息用新的 id。
 */
export function MessageComposer({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [clientMessageId, setClientMessageId] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * 等待这一批消息的 AI 判断完成。
   *
   * 引入"连续消息合并"后，发消息接口不再同步返回建议 —— 它会先等一个聚合窗口
   * （客户可能还在继续打字），窗口关闭后才统一判断。所以这里轮询批次状态，
   * 一旦建议生成就刷新页面。整个过程对销售是可见的："已收到，正在等待后续消息…"。
   */
  async function waitForSuggestion(batchId: string, windowMs: number) {
    const deadline = Date.now() + Math.max(30_000, windowMs * 4);
    setNotice(`已收到消息，正在等待客户是否继续发言…（约 ${Math.round(windowMs / 1000)} 秒后统一判断）`);

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
          const count = data.batchMessageCount ?? 1;
          setNotice(count > 1 ? `AI 已把本轮 ${count} 条消息合并判断完成` : null);
          router.refresh();
          return;
        }
      } catch {
        /* 轮询失败就继续等，超时后给用户一个提示 */
      }
    }

    setNotice('AI 判断仍在进行，可稍后刷新页面查看结果');
    router.refresh();
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
        await waitForSuggestion(data.batchId, data.batchWindowMs ?? 8000);
      }
    } catch {
      setClientMessageId(id);
      setError('网络异常，可直接重试（同一条消息不会重复入库）');
    } finally {
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
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">{notice}</div>
      ) : null}
    </form>
  );
}
