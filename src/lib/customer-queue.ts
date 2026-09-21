import type { LeadStage } from '@/generated/prisma/enums';

/**
 * 客户列表的**待办优先级** —— 回答销售唯一真正关心的问题："我现在该处理谁？"
 *
 * 背景（一次可用性返工）：
 *   原版客户列表按 `updatedAt` 倒序，看起来"挺合理"，实际上没有回答上面那个问题 ——
 *   一个已经成交的客户，和一位正在等人回话、且已经静默 40 分钟的客户，排序上没有区别。
 *   而系统明明知道这两者的差别（`CustomerState.needHuman` / `lastCustomerMessageAt`）。
 *
 * 设计要点：
 *   1. **纯函数**（无 IO、无 prisma）→ 可以对每个桶逐条写断言，规则改动不会悄悄跑偏。
 *   2. **终态不一定沉底**：终态客户通常不该再打扰（沉底），但如果它同时被标记"需要人工"
 *      （例如成交后要人工确认），那它仍然是一件**待办** —— 人的事永远排在前面。
 *   3. **保守**：这里只做"排序与提示"，不做任何状态变更，也不会因为排序而漏掉任何客户
 *      （未命中的一律落到 NORMAL，仍然看得见）。
 */

export type QueueBucket = 'NEED_HUMAN' | 'FOLLOW_UP' | 'NEEDS_REPLY' | 'NORMAL' | 'CLOSED';

export type QueueTone = 'rose' | 'amber' | 'indigo' | 'slate' | 'emerald';

export type QueueClass = {
  bucket: QueueBucket;
  /** 排序权重：越小越靠前 */
  priority: number;
  label: string;
  hint: string;
  tone: QueueTone;
};

const TERMINAL: readonly LeadStage[] = ['WON', 'LOST'];

export function classifyCustomerForQueue(input: {
  needHuman: boolean;
  leadStage: LeadStage;
  /** 客户最后一次说话的时间（null = 客户从未说过话） */
  lastCustomerMessageAt: Date | null;
  /** 静默多少分钟算"该跟进了"（与 Follow-up 保持同一个阈值） */
  idleMinutes: number;
  now: Date;
}): QueueClass {
  // ① 人的事最大：只要标记了需要人工，无论阶段都排在最前
  if (input.needHuman) {
    return {
      bucket: 'NEED_HUMAN',
      priority: 0,
      label: '需要人工',
      hint: '已标记需人工介入，等你去接',
      tone: 'rose',
    };
  }

  // ② 终态（成交/流失）：不再打扰，沉底
  if (TERMINAL.includes(input.leadStage)) {
    return {
      bucket: 'CLOSED',
      priority: 90,
      label: '已结束',
      hint: '已是终态，无需自动跟进',
      tone: 'emerald',
    };
  }

  const last = input.lastCustomerMessageAt;
  if (!last) {
    return {
      bucket: 'NORMAL',
      priority: 50,
      label: '待判断',
      hint: '客户还没说过话',
      tone: 'slate',
    };
  }

  const idleMs = input.now.getTime() - last.getTime();
  const idleMinutes = idleMs / 60_000;

  // ③ 客户说过话且已经静默超时 —— 最典型的"该主动跟进"
  if (idleMinutes >= input.idleMinutes) {
    return {
      bucket: 'FOLLOW_UP',
      priority: 10,
      label: '该跟进',
      hint: `客户已静默约 ${Math.round(idleMinutes)} 分钟，建议主动跟进`,
      tone: 'amber',
    };
  }

  // ④ 客户刚说完话 —— 轮到我们回（这是销售最该立刻处理的场景）
  return {
    bucket: 'NEEDS_REPLY',
    priority: 20,
    label: '待回复',
    hint: '客户刚发来消息，等你回复',
    tone: 'indigo',
  };
}

/** 待办 = 需要人处理的（不含已结束与纯等待） */
export function isActionable(bucket: QueueBucket): boolean {
  return bucket === 'NEED_HUMAN' || bucket === 'FOLLOW_UP' || bucket === 'NEEDS_REPLY';
}
