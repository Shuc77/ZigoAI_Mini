import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { prisma } from '@/lib/db';
import type { AuthContext } from '@/lib/types';
import { systemAuthContext } from '@/server/system-context';
import { runAgent, type AgentTrigger } from './pipeline';

/**
 * 连续消息合并（进阶挑战 2）。
 *
 * 真实微信场景里，客户常常连发好几条：
 *   你好 / 我想咨询一下 / 你们多少钱 / 适合我们公司吗 / 有人吗
 * 如果每条消息都独立触发一次 AI，就会连续回复 5 次 —— 既像机器人，也浪费 token。
 *
 * 本实现把"一段时间窗口内到达的消息"合并成**一轮沟通**，只跑一次 pipeline。
 *
 * 三个设计要点（答辩可以直接讲）：
 *
 * 1) **批次状态存在数据库里，不只在内存**。
 *    每条客户消息都带 `batchId`；"这一批是否还没被判断过" = 该 batchId 在 AiSuggestion 里没有记录。
 *    因此进程重启后，未处理的批次依然能被找回，而不会永久丢失。
 *
 * 2) **窗口到期由"进程内定时器 + 兜底扫描"共同保证**。
 *    单实例部署下 setTimeout 足够用；但定时器可能因为重启而丢失，所以每次有新消息进来时
 *    都会顺带扫一遍**已过期但未被判断的批次**（`sweepExpiredBatches`），
 *    另外还提供 `pnpm agent:scan` 供定时任务/人工触发。这是"不能只依赖内存定时器"的落地。
 *
 * 3) **窗口期内只入队、不调用 AI**。
 *    第一条消息到达时开窗，后续消息加入同一批次并让窗口顺延（客户还在打字就不急着回），
 *    窗口关闭时才带着**整批消息**做一次判断。
 */

/** 进程内待处理批次：batchId → 定时器与首次开窗时间，避免同一批次被重复调度 */
const scheduledTimers = new Map<string, { timer: NodeJS.Timeout; firstSeenAt: number }>();

/** 最长等待：即使客户一直打字，也不能让判断无限推迟（3 个窗口） */
const MAX_WAIT_MULTIPLIER = 3;

/**
 * 为新到的客户消息决定它属于哪一批。
 * 规则：该客户最近一条"尚未被判断过"的客户消息，若距今仍在窗口内，就并进同一批。
 */
export async function resolveBatchId(
  ctx: AuthContext,
  customerId: string,
  now = new Date(),
): Promise<{ batchId: string; isNewBatch: boolean }> {
  const latest = await prisma.message.findFirst({
    where: { tenantId: ctx.tenantId, customerId, role: 'CUSTOMER', batchId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { batchId: true, createdAt: true },
  });

  if (latest?.batchId) {
    const ageMs = now.getTime() - latest.createdAt.getTime();
    if (ageMs <= env.batchWindowMs) {
      // 该批次是否已被判断过？已判断过就不再复用，避免"新消息混进旧结论"
      const judged = await prisma.aiSuggestion.findFirst({
        where: { batchId: latest.batchId },
        select: { id: true },
      });
      if (!judged) return { batchId: latest.batchId, isNewBatch: false };
    }
  }

  return { batchId: randomUUID(), isNewBatch: true };
}

/**
 * 为一个批次安排处理：窗口到期后跑一次 pipeline。
 * 同一批次重复调用是安全的（内存里有去重表）。
 */
export function scheduleBatch(params: {
  batchId: string;
  tenantId: string;
  customerId: string;
  delayMs?: number;
}): void {
  const now = Date.now();
  const existing = scheduledTimers.get(params.batchId);

  // 客户还在继续发消息 → 让窗口顺延（重新计时），但不能超过最长等待
  if (existing) {
    clearTimeout(existing.timer);
    scheduledTimers.delete(params.batchId);
  }

  const firstSeenAt = existing?.firstSeenAt ?? now;
  const maxWaitMs = env.batchWindowMs * MAX_WAIT_MULTIPLIER;
  const remainingMaxWait = Math.max(0, firstSeenAt + maxWaitMs - now);
  const delay = Math.min(params.delayMs ?? env.batchWindowMs, remainingMaxWait);

  const timer = setTimeout(() => {
    scheduledTimers.delete(params.batchId);
    void processBatch(params.batchId, params.tenantId, params.customerId).catch((error) => {
      console.error(`[batch] 处理批次失败 batchId=${params.batchId}`, error);
    });
  }, delay);

  // 定时器不应阻止进程退出
  timer.unref?.();
  scheduledTimers.set(params.batchId, { timer, firstSeenAt });
}

/** 立即处理一个批次：把该批次内的**全部**客户消息作为一轮沟通交给 AI */
export async function processBatch(
  batchId: string,
  tenantId: string,
  customerId: string,
  trigger: AgentTrigger = 'NEW_MESSAGE',
): Promise<{ processed: boolean; messageCount: number }> {
  const messages = await prisma.message.findMany({
    where: { tenantId, customerId, batchId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true },
  });

  const customerMessageIds = messages.filter((m) => m.role === 'CUSTOMER').map((m) => m.id);
  if (customerMessageIds.length === 0) return { processed: false, messageCount: 0 };

  // 幂等：该批次已经产过建议就不再重复调用 AI（防止定时器与兜底扫描同时命中）
  const existing = await prisma.aiSuggestion.findFirst({ where: { batchId }, select: { id: true } });
  if (existing) return { processed: false, messageCount: customerMessageIds.length };

  await runAgent({
    ctx: systemAuthContext(tenantId),
    customerId,
    messageIds: customerMessageIds,
    batchId,
    trigger,
  });

  return { processed: true, messageCount: customerMessageIds.length };
}

/**
 * 兜底扫描：找出"窗口已过期但尚未产生建议"的批次并处理掉。
 *
 * 什么时候会有这种批次：进程重启导致内存定时器丢失、或定时器回调抛异常。
 * 调用时机：① 每次有新消息进来时（顺带扫一遍，成本极低）；② `pnpm agent:scan`（定时任务）。
 */
export async function sweepExpiredBatches(limit = 20): Promise<Array<{ batchId: string; messages: number }>> {
  const cutoff = new Date(Date.now() - env.batchWindowMs);

  // 找出所有带 batchId 的客户消息，按批次聚合后筛出"最新一条已过期且没有建议"的
  const rows = await prisma.message.findMany({
    where: { role: 'CUSTOMER', batchId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { batchId: true, tenantId: true, customerId: true, createdAt: true },
  });

  const batches = new Map<string, { tenantId: string; customerId: string; latest: Date; count: number }>();
  for (const row of rows) {
    if (!row.batchId) continue;
    const current = batches.get(row.batchId);
    if (current) {
      current.count += 1;
      if (row.createdAt > current.latest) current.latest = row.createdAt;
    } else {
      batches.set(row.batchId, {
        tenantId: row.tenantId,
        customerId: row.customerId,
        latest: row.createdAt,
        count: 1,
      });
    }
  }

  const candidates = [...batches.entries()]
    .filter(([, info]) => info.latest <= cutoff)
    .slice(0, limit);

  if (candidates.length === 0) return [];

  const judged = await prisma.aiSuggestion.findMany({
    where: { batchId: { in: candidates.map(([batchId]) => batchId) } },
    select: { batchId: true },
  });
  const judgedSet = new Set(judged.map((row) => row.batchId));

  const results: Array<{ batchId: string; messages: number }> = [];
  for (const [batchId, info] of candidates) {
    if (judgedSet.has(batchId)) continue;
    try {
      const result = await processBatch(batchId, info.tenantId, info.customerId);
      if (result.processed) results.push({ batchId, messages: result.messageCount });
    } catch (error) {
      console.error(`[batch] 兜底扫描处理失败 batchId=${batchId}`, error);
    }
  }

  return results;
}

/** 某一批次包含多少条客户消息（用于在 AI 卡片上展示"本轮合并了 N 条"） */
export async function countBatchMessages(tenantId: string, batchId: string): Promise<number> {
  return prisma.message.count({ where: { tenantId, batchId, role: 'CUSTOMER' } });
}

/**
 * 该客户当前"首次判断"的状态 —— **廉价检查，不触发任何 AI 调用**。
 *
 * - `NONE`：已经有判断，或客户压根没说过话 → 不需要等待
 * - `BACKFILL`：有客户消息但从未判断过 → 需要**补跑**（种子数据直接写库、历史导入、
 *   数据迁移，或进程在聚合窗口期间重启，都会留下这种客户）
 * - `IN_FLIGHT`：消息已归批但判断还没落库 → 判断**正在跑**，界面同样要等待
 *
 * 为什么必须把 `IN_FLIGHT` 也算进来（这是真实踩过的坑）：
 * 只判断"有没有未归批的消息"时，页面渲染会在后台补跑启动后立刻变成 false，
 * 于是**第二次打开/刷新**页面就退回「还没有 AI 判断」这张误导性的占位卡，
 * 而且不再轮询 —— 用户看到的现象就是"要刷新好几次判断才出来"。
 * 判断正在跑和判断还没开始，对用户是同一件事：**等一会儿就好**。
 *
 * 语义上这与 `sweepExpiredBatches` 同类：**入口漏掉的消息，系统必须能自己补上**。
 */
export type FirstJudgmentWait = 'NONE' | 'BACKFILL' | 'IN_FLIGHT';

export async function firstJudgmentWait(params: {
  tenantId: string;
  customerId: string;
}): Promise<FirstJudgmentWait> {
  const existing = await prisma.aiSuggestion.findFirst({
    where: { tenantId: params.tenantId, customerId: params.customerId },
    select: { id: true },
  });
  if (existing) return 'NONE';

  const [unbatched, batched] = await Promise.all([
    prisma.message.count({
      where: {
        tenantId: params.tenantId,
        customerId: params.customerId,
        role: 'CUSTOMER',
        batchId: null,
      },
    }),
    prisma.message.count({
      where: {
        tenantId: params.tenantId,
        customerId: params.customerId,
        role: 'CUSTOMER',
        batchId: { not: null },
      },
    }),
  ]);

  if (unbatched > 0) return 'BACKFILL';
  return batched > 0 ? 'IN_FLIGHT' : 'NONE';
}

/**
 * 补跑「首次判断」。
 *
 * **不要直接 await 在页面渲染里**：那会让首屏等一次 AI 调用（1–3 秒甚至更久），
 * 并且会和 Next 的预取/客户端缓存产生奇怪交互（实测表现为"刷新几次才看到判断"）。
 * 正确用法是页面先 `needsInitialJudgment()` 判断，再把这个函数丢到后台执行，
 * 同时给前端一个明确的"正在生成首次判断…"状态并轮询（见 judgment-pending.tsx）。
 *
 * 幂等：已有任何判断 → 直接返回；没有未归批的客户消息 → 直接返回；
 * 归批后交给 `processBatch`，它自身还会再检查一次"该批次是否已有建议"。
 */
export async function runInitialJudgment(params: {
  tenantId: string;
  customerId: string;
}): Promise<{ triggered: boolean; messageCount: number }> {
  const existing = await prisma.aiSuggestion.findFirst({
    where: { tenantId: params.tenantId, customerId: params.customerId },
    select: { id: true },
  });
  if (existing) return { triggered: false, messageCount: 0 };

  const unbatched = await prisma.message.findMany({
    where: { tenantId: params.tenantId, customerId: params.customerId, role: 'CUSTOMER', batchId: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (unbatched.length === 0) return { triggered: false, messageCount: 0 };

  // 把这些"从没被判断过"的历史消息归到同一批，并标记为**补跑**（界面上要与"客户连发"区分开）
  const batchId = randomUUID();
  await prisma.message.updateMany({
    where: { id: { in: unbatched.map((message) => message.id) } },
    data: { batchId },
  });

  const result = await processBatch(batchId, params.tenantId, params.customerId, 'INITIAL_BACKFILL');
  return { triggered: result.processed, messageCount: result.messageCount };
}
