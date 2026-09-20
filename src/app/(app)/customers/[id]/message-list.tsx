'use client';

import { useEffect, useRef, useState } from 'react';
import { formatDateTime } from '@/lib/format';

export type ChatMessage = {
  id: string;
  role: 'CUSTOMER' | 'SALES';
  content: string;
  /** ISO 字符串（跨 Server/Client 边界传值，避免时区与序列化歧义） */
  createdAt: string;
};

/**
 * 聊天记录列表。
 *
 * 两个职责：
 *  1) **布局**：作为左栏卡片中的弹性区域（`flex-1`），把剩余高度全部吃掉 ——
 *     这样左栏卡片的总高度由外层栅格决定，与右栏严格等高。
 *     窄屏（无固定高度）时退化为 `max-h-[70vh]` 的内部滚动，避免页面被聊天记录撑爆。
 *  2) **粘底滚动**：新消息到达后自动滚到最新一条，但**不打断**正在往上翻历史的用户。
 */
export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const lastMessageId = messages.at(-1)?.id ?? null;

  // 首次渲染：直接看到最新几条
  useEffect(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  // 新消息到达：原本贴着底部就继续贴着（发送后自动下滑的关键）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (stickToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      setShowJumpButton(false);
    }
  }, [lastMessageId]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceToBottom < 80;
    stickToBottomRef.current = atBottom;
    setShowJumpButton(!atBottom && messages.length > 0);
  }

  function jumpToLatest() {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    stickToBottomRef.current = true;
    setShowJumpButton(false);
  }

  return (
    <div className="relative flex flex-col lg:min-h-0 lg:flex-1">
      <div
        ref={containerRef}
        data-testid="chat-messages"
        onScroll={handleScroll}
        className="min-h-[280px] max-h-[70vh] space-y-3 overflow-y-auto px-4 py-4 lg:max-h-none lg:min-h-0 lg:flex-1"
      >
        {messages.map((message) => {
          const isCustomer = message.role === 'CUSTOMER';
          return (
            <div key={message.id} className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`}>
              <div className="max-w-[80%]">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
                  <span>{isCustomer ? '客户' : '销售'}</span>
                  <span>{formatDateTime(message.createdAt)}</span>
                </div>
                <div
                  className={`prewrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                    isCustomer
                      ? 'border border-slate-200 bg-slate-50 text-slate-800'
                      : 'bg-indigo-600 text-white'
                  }`}
                >
                  {message.content}
                </div>
              </div>
            </div>
          );
        })}

        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">还没有聊天记录</p>
        ) : null}
      </div>

      {showJumpButton ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-slate-200 bg-white/95 px-3 py-1 text-[11px] text-slate-600 shadow-sm backdrop-blur transition hover:border-indigo-300 hover:text-indigo-600"
        >
          回到最新 ↓
        </button>
      ) : null}
    </div>
  );
}
