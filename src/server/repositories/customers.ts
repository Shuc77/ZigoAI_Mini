import { prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import type { AuthContext } from '@/lib/types';

/**
 * 客户仓储层 —— **多租户隔离的唯一边界**。
 *
 * 铁律：本文件所有导出函数的第一个参数都是 AuthContext，且查询条件里必须出现 scope。
 * 上层（页面/接口）永远不直接使用 prisma.customer，这样"越权访问"在结构上就不可能发生，
 * 而不是靠每次写查询时记得加 where。
 *
 * 角色规则：
 *   - SALES   ：只能看到/操作自己名下的客户
 *   - MANAGER ：可以看到/操作本企业的全部客户
 * 跨企业访问一律查不到 → 上层返回 404（不暴露"存在但不属于你"）。
 */
export function customerScope(ctx: AuthContext) {
  return ctx.role === 'SALES'
    ? { tenantId: ctx.tenantId, assigneeId: ctx.userId }
    : { tenantId: ctx.tenantId };
}

const customerListInclude = {
  state: true,
  assignee: { select: { id: true, name: true } },
  _count: { select: { messages: true } },
} as const;

export async function listCustomers(ctx: AuthContext) {
  return prisma.customer.findMany({
    where: customerScope(ctx),
    include: customerListInclude,
    orderBy: [{ updatedAt: 'desc' }],
  });
}

/** 查不到时返回 null —— 调用方统一转 404 */
export async function findCustomer(ctx: AuthContext, customerId: string) {
  return prisma.customer.findFirst({
    where: { id: customerId, ...customerScope(ctx) },
    include: {
      state: true,
      assignee: { select: { id: true, name: true } },
      tenant: { select: { id: true, name: true, salesGoal: true } },
    },
  });
}

/** 与 findCustomer 相同，但查不到直接抛 404（供页面使用） */
export async function requireCustomer(ctx: AuthContext, customerId: string) {
  const customer = await findCustomer(ctx, customerId);
  if (!customer) throw notFound('客户');
  return customer;
}

export type CreateCustomerInput = {
  name: string;
  handle: string;
  phone?: string | null;
  source?: string | null;
  note?: string | null;
  /** 仅主管可指定归属人；销售只能建给自己 */
  assigneeId?: string | null;
};

export async function createCustomer(ctx: AuthContext, input: CreateCustomerInput) {
  let assigneeId = ctx.userId;

  if (input.assigneeId && ctx.role === 'MANAGER') {
    // 归属人必须在同一租户内，否则忽略（防止跨租户指派）
    const target = await prisma.user.findFirst({
      where: { id: input.assigneeId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (target) assigneeId = target.id;
  }

  return prisma.customer.create({
    data: {
      tenantId: ctx.tenantId,
      name: input.name,
      handle: input.handle,
      phone: input.phone ?? null,
      source: input.source ?? null,
      note: input.note ?? null,
      assigneeId,
      // 新客户同时建立初始销售状态，保证详情页永远有状态可读
      state: {
        create: {
          tenantId: ctx.tenantId,
          leadStage: 'NEW',
          intent: '待判断',
          needHuman: false,
        },
      },
    },
    include: customerListInclude,
  });
}

/** 本企业可见的销售成员（主管指派时用） */
export async function listAssignableUsers(ctx: AuthContext) {
  return prisma.user.findMany({
    where: { tenantId: ctx.tenantId, role: 'SALES' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * 人工状态操作 —— 与 AI 判断相对的"人的决定"。
 *
 * 为什么必须有这组接口：状态机把三件事锁死了（终态不可由 AI 改动、阶段不回退、
 * 需人工标记只升不降），那么"解除"与"确认终态"就必须由人来完成，否则系统会卡在
 * 需人工/高意向状态里无法继续。这正是"AI 提建议、人做决定"的落地。
 */
export type HumanStateAction = 'RESOLVE_HUMAN' | 'CONFIRM_WON' | 'CONFIRM_LOST' | 'REOPEN';

export async function applyHumanStateAction(
  ctx: AuthContext,
  customerId: string,
  action: HumanStateAction,
) {
  const customer = await requireCustomer(ctx, customerId);
  if (!customer.state) throw notFound('客户状态');

  const data =
    action === 'RESOLVE_HUMAN'
      ? { needHuman: false, humanReason: null }
      : action === 'CONFIRM_WON'
        ? { leadStage: 'WON' as const, needHuman: false, humanReason: null }
        : action === 'CONFIRM_LOST'
          ? { leadStage: 'LOST' as const, needHuman: false, humanReason: null }
          : {
              // 撤销终态：成交的退回高意向，流失的退回探需
              leadStage: customer.state.leadStage === 'WON' ? ('HIGH_INTENT' as const) : ('DISCOVERY' as const),
              needHuman: false,
              humanReason: null,
            };

  // 乐观锁：人的操作同样不能覆盖并发中的 AI 判断
  const updated = await prisma.customerState.updateMany({
    where: { customerId: customer.id, version: customer.state.version },
    data: { ...data, version: { increment: 1 } },
  });

  if (updated.count === 0) {
    // 并发冲突：重新读取版本后重试一次
    const fresh = await prisma.customerState.findUniqueOrThrow({ where: { customerId: customer.id } });
    await prisma.customerState.updateMany({
      where: { customerId: customer.id, version: fresh.version },
      data: { ...data, version: { increment: 1 } },
    });
  }

  return prisma.customerState.findUniqueOrThrow({ where: { customerId: customer.id } });
}
