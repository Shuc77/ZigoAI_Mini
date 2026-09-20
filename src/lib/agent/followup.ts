import type { LeadStage } from '@/generated/prisma/enums';
import { env } from '@/lib/env';
import { prisma } from '@/lib/db';
import { STAGE_ORDER, TERMINAL_STAGES } from '@/lib/types';
import { systemAuthContext } from '@/server/system-context';
import { runAgent } from './pipeline';

/**
 * Follow-up（进阶挑战 1）：客户聊到一半不回复了，系统要知道"该跟进了"。
 *
 * 这个功能的难点不在"定时器怎么实现"，而在**判定规则**：题目明确要求考虑
 *   什么情况下需要跟进？什么情况下不跟进？已经成交怎么办？已经转人工怎么办？是否限制跟进次数？
 * 因此核心是一个**纯函数判定矩阵**（`evaluateFollowUp`），可以完全用单元测试覆盖；
 * 扫描与调度只是它的外层壳子。
 *
 * 判定顺序（短路，越靠前越优先）：
 *   ① 终态（成交/流失）        → 不跟进：已经结束的客户不需要再打扰
 *   ② 已标记需人工            → 不跟进：由人处理，系统不再自动催
 *   ③ 已有待处理跟进任务      → 不跟进：幂等，避免重复创建
 *   ④ 已达跟进次数上限        → 不跟进：防止无限打扰客户
 *   ⑤ 未过冷却期              → 不跟进：刚跟进过，别连着发
 *   ⑥ 客户从未说过话          → 不跟进：没有"未回复"这回事
 *   ⑦ 客户最后发言未超时      → 不跟进：还没到该催的时候
 *   ⑧ 销售已在客户之后回过话  → 不跟进：**球在客户那边**，催的是我们自己
 *   ⑨ 其余                    → 跟进
 *
 * 第 ⑧ 条是最容易被忽略、也最容易造成骚扰的一条：如果销售刚回了话，
 * 客户沉默是正常的（人家在考虑），此时再发跟进只会显得催促。
 */

export type FollowUpRule =
  | 'TERMINAL_STAGE'
  | 'HUMAN_PENDING'
  | 'PENDING_TASK'
  | 'MAX_ATTEMPTS'
  | 'COOLDOWN'
  | 'NEVER_SPOKE'
  | 'NOT_IDLE'
  | 'JUST_REPLIED'
  | 'SHOULD_FOLLOW_UP';

export type FollowUpDecision = {
  shouldFollowUp: boolean;
  rule: FollowUpRule;
  reason: string;
};

export type FollowUpInput = {
  leadStage: LeadStage;
  needHuman: boolean;
  lastCustomerMessageAt: Date | null;
  lastSalesMessageAt: Date | null;
  followUpCount: number;
  lastFollowUpAt: Date | null;
  hasPendingTask: boolean;
  now: Date;
  idleMinutes: number;
  maxAttempts: number;
  cooldownMinutes: number;
};

export function evaluateFollowUp(input: FollowUpInput): FollowUpDecision {
  const idleMs = input.idleMinutes * 60_000;

  if (TERMINAL_STAGES.includes(input.leadStage)) {
    return { shouldFollowUp: false, rule: 'TERMINAL_STAGE', reason: '客户已是终态（成交/流失），不再自动跟进' };
  }

  if (input.needHuman) {
    return { shouldFollowUp: false, rule: 'HUMAN_PENDING', reason: '已标记需人工介入，由销售人工处理，系统不自动催' };
  }

  if (input.hasPendingTask) {
    return { shouldFollowUp: false, rule: 'PENDING_TASK', reason: '已有待处理的跟进任务，避免重复创建' };
  }

  if (input.followUpCount >= input.maxAttempts) {
    return {
      shouldFollowUp: false,
      rule: 'MAX_ATTEMPTS',
      reason: `已达到跟进次数上限（${input.maxAttempts} 次），停止自动跟进以免骚扰客户`,
    };
  }

  if (input.lastFollowUpAt) {
    const sinceLast = input.now.getTime() - input.lastFollowUpAt.getTime();
    if (sinceLast < input.cooldownMinutes * 60_000) {
      const minutes = Math.round(sinceLast / 60_000);
      return {
        shouldFollowUp: false,
        rule: 'COOLDOWN',
        reason: `距上次跟进仅 ${minutes} 分钟，仍在冷却期（${input.cooldownMinutes} 分钟）`,
      };
    }
  }

  if (!input.lastCustomerMessageAt) {
    return { shouldFollowUp: false, rule: 'NEVER_SPOKE', reason: '客户还没有说过话，不存在"未回复"' };
  }

  const idle = input.now.getTime() - input.lastCustomerMessageAt.getTime();
  if (idle < idleMs) {
    const minutes = Math.max(1, Math.round(idle / 60_000));
    return {
      shouldFollowUp: false,
      rule: 'NOT_IDLE',
      reason: `客户 ${minutes} 分钟前还在说话，未达到静默阈值（${input.idleMinutes} 分钟）`,
    };
  }

  if (input.lastSalesMessageAt) {
    const sinceOurReply = input.now.getTime() - input.lastSalesMessageAt.getTime();
    if (sinceOurReply < input.cooldownMinutes * 60_000) {
      return {
        shouldFollowUp: false,
        rule: 'JUST_REPLIED',
        reason: `销售 ${Math.max(1, Math.round(sinceOurReply / 60_000))} 分钟前刚回过话，等一会儿再跟进（避免连续催）`,
      };
    }
  }

  return {
    shouldFollowUp: true,
    rule: 'SHOULD_FOLLOW_UP',
    reason: `客户已静默约 ${Math.round(idle / 60_000)} 分钟（阈值 ${input.idleMinutes} 分钟），且阶段为 ${input.leadStage}，建议主动跟进`,
  };
}

/** 跟随的冷却期：默认取静默阈值的 2 倍 */
export function cooldownMinutes(): number {
  return env.followUpCooldownMinutes > 0 ? env.followUpCooldownMinutes : env.followUpIdleMinutes * 2;
}

/**
 * 扫描并执行跟进（供演示按钮与定时任务调用）。
 *
 * 幂等保证有两层：
 *   ① 判定矩阵里的 `PENDING_TASK`（已有待处理任务就不再建）
 *   ② 数据库唯一索引 `FollowUpTask(tenantId, customerId, attempt)` —— 并发下也不会重复
 */
export async function scanFollowUps(options: {
  tenantId?: string;
  /** 只看某个客户（客户详情页的"立即扫描跟进"用这个，避免顺手把整个租户都扫一遍） */
  customerId?: string;
  limit?: number;
  now?: Date;
} = {}): Promise<
  Array<{ customerId: string; customerName: string; reason: string; suggestionId: string | null }>
> {
  const now = options.now ?? new Date();

  const customers = await prisma.customer.findMany({
    where: {
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options.customerId ? { id: options.customerId } : {}),
      state: { isNot: null },
    },
    include: { state: true },
    take: options.limit ?? 100,
  });

  const results: Array<{ customerId: string; customerName: string; reason: string; suggestionId: string | null }> = [];

  for (const customer of customers) {
    const state = customer.state;
    if (!state) continue;

    // 数据源说明（踩过一次坑）：**客户最后发言时间读状态表的聚合值**，而不是去 Message 表查最后一条。
    // 原因：状态表是判定用的聚合事实（schema 里就是这么定义的），而且"模拟时间流逝"只改状态表；
    // 若这里改查消息表，时间旅行就会失效（实测表现为 rule=NOT_IDLE，看起来像跟进逻辑坏了）。
    // 销售最后发言时间仍查消息表 —— 它不在状态表里，也不受时间旅行影响。
    const lastSalesMessage = await prisma.message.findFirst({
      where: { customerId: customer.id, role: 'SALES' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const pendingTask = await prisma.followUpTask.findFirst({
      where: { customerId: customer.id, status: 'PENDING' },
      select: { id: true },
    });

    const decision = evaluateFollowUp({
      leadStage: state.leadStage,
      needHuman: state.needHuman,
      lastCustomerMessageAt: state.lastCustomerMessageAt,
      lastSalesMessageAt: lastSalesMessage?.createdAt ?? null,
      followUpCount: state.followUpCount,
      lastFollowUpAt: state.lastFollowUpAt,
      hasPendingTask: pendingTask !== null,
      now,
      idleMinutes: env.followUpIdleMinutes,
      maxAttempts: env.followUpMaxAttempts,
      cooldownMinutes: cooldownMinutes(),
    });

    if (!decision.shouldFollowUp) continue;

    /*
     * 两个计数器各司其职（这里踩过一次真实的坑）：
     *   - FollowUpTask.attempt  → **幂等键**，必须单调递增，绝不重置；
     *   - CustomerState.followUpCount → **业务计数**（本轮对话跟进过几次），客户再次发言时归零。
     * 最初我把 attempt 取成 `followUpCount + 1`，于是"客户回话 → 计数归零 → 下次跟进又算 attempt=1"
     * 直接撞上唯一索引 (tenantId, customerId, attempt)，跟进被静默跳过（表现为 followed=false 但判定说该跟进）。
     */
    const lastTask = await prisma.followUpTask.findFirst({
      where: { customerId: customer.id },
      orderBy: { attempt: 'desc' },
      select: { attempt: true },
    });
    const attempt = (lastTask?.attempt ?? 0) + 1;

    // ② 数据库唯一索引兜底：并发/重复扫描时只会有一条任务
    let task;
    try {
      task = await prisma.followUpTask.create({
        data: {
          tenantId: customer.tenantId,
          customerId: customer.id,
          status: 'PENDING',
          dueAt: now,
          reason: decision.reason,
          attempt,
        },
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        continue;
      }
      throw error;
    }

    try {
      // 复用同一条 pipeline：跟进建议的生成逻辑与常规判断完全一致，只是触发来源不同
      const agent = await runAgent({
        ctx: systemAuthContext(customer.tenantId),
        customerId: customer.id,
        trigger: 'FOLLOW_UP',
      });

      await prisma.$transaction([
        prisma.followUpTask.update({
          where: { id: task.id },
          data: { status: 'SENT', suggestionId: agent.suggestion.id },
        }),
        prisma.customerState.updateMany({
          where: { customerId: customer.id },
          data: { followUpCount: { increment: 1 }, lastFollowUpAt: now },
        }),
      ]);

      results.push({
        customerId: customer.id,
        customerName: customer.name,
        reason: decision.reason,
        suggestionId: agent.suggestion.id,
      });
    } catch (error) {
      // 生成失败：任务标记为跳过，避免卡在 PENDING 上把后续扫描全部挡掉
      console.error(`[followup] 生成跟进建议失败 customerId=${customer.id}`, error);
      await prisma.followUpTask.update({ where: { id: task.id }, data: { status: 'SKIPPED' } });
    }
  }

  return results;
}

/**
 * 演示用"时间旅行"：把这位客户的**整段对话整体后移** N 分钟，用于立刻复现"客户静默超时"。
 *
 * 为什么需要它：真实阈值是分钟级，演示时不可能真的等。题目也明确允许
 * "设置很短的时间 / 做一个测试按钮 / 手工模拟时间变化"。
 *
 * 实现要点：**必须连着消息一起后移**，否则数据会自相矛盾 —— 状态表说"客户 30 分钟没说话"，
 * 消息表里却躺着一句 1 分钟前的销售回复，"销售刚回过话"的判定就会误触发（实测踩过）。
 * 只影响这一个客户，且是明确的演示动作，不改动其它租户/客户的数据。
 */
export async function timeTravelCustomer(customerId: string, minutes: number): Promise<void> {
  const shiftMs = minutes * 60_000;

  const messages = await prisma.message.findMany({
    where: { customerId },
    select: { id: true, createdAt: true },
  });
  const state = await prisma.customerState.findUnique({ where: { customerId } });

  const shift = (value: Date | null): Date | null =>
    value ? new Date(value.getTime() - shiftMs) : null;

  await prisma.$transaction([
    ...messages.map((message) =>
      prisma.message.update({
        where: { id: message.id },
        data: { createdAt: shift(message.createdAt) as Date },
      }),
    ),
    prisma.customerState.update({
      where: { customerId },
      data: {
        lastCustomerMessageAt: shift(state?.lastCustomerMessageAt ?? null),
        lastContactAt: shift(state?.lastContactAt ?? null),
        // 清零跟进冷却，让"模拟静默"之后立刻可以触发一次跟进
        lastFollowUpAt: null,
        version: { increment: 1 },
      },
    }),
  ]);
}

/** 该客户当前是否满足跟进条件（用于界面展示"为什么还不用跟进"） */
export async function explainFollowUp(customerId: string) {
  const state = await prisma.customerState.findUnique({ where: { customerId } });
  if (!state) return null;

  // 与 scanFollowUps 保持同一数据源：客户时间取状态表，销售时间取消息表
  const [lastSalesMessage, pendingTask] = await Promise.all([
    prisma.message.findFirst({
      where: { customerId, role: 'SALES' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.followUpTask.findFirst({ where: { customerId, status: 'PENDING' }, select: { id: true } }),
  ]);

  return evaluateFollowUp({
    leadStage: state.leadStage,
    needHuman: state.needHuman,
    lastCustomerMessageAt: state.lastCustomerMessageAt,
    lastSalesMessageAt: lastSalesMessage?.createdAt ?? null,
    followUpCount: state.followUpCount,
    lastFollowUpAt: state.lastFollowUpAt,
    hasPendingTask: pendingTask !== null,
    now: new Date(),
    idleMinutes: env.followUpIdleMinutes,
    maxAttempts: env.followUpMaxAttempts,
    cooldownMinutes: cooldownMinutes(),
  });
}

/** 便于阶段排序的工具（供测试与展示使用） */
export function stageRank(stage: LeadStage): number {
  return STAGE_ORDER[stage];
}
