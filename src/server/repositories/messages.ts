import { prisma } from '@/lib/db';
import { badRequest, notFound } from '@/lib/errors';
import type { AuthContext } from '@/lib/types';
import { requireCustomer } from '@/server/repositories/customers';

/**
 * 消息仓储层 —— 同样强制租户作用域。
 *
 * 两个业务不变量在这里落地：
 *  1) **消息必须归属某个客户，且该客户必须在当前用户可见范围内**（否则 404）
 *  2) **幂等**：同租户内相同的 clientMessageId 只会落库一次。
 *     这是"客户端重试 / 用户连点两次 / 网络抖动重发"都不会产生重复消息的基石，
 *     也是后续"AI 重复回复"问题的第一道防线。
 */

export async function listMessages(ctx: AuthContext, customerId: string) {
  await requireCustomer(ctx, customerId);

  return prisma.message.findMany({
    where: { tenantId: ctx.tenantId, customerId },
    orderBy: { createdAt: 'asc' },
  });
}

export type AppendMessageResult = {
  message: Awaited<ReturnType<typeof prisma.message.create>>;
  deduplicated: boolean;
};

type AppendInput = {
  customerId: string;
  content: string;
  /** 客户端生成的去重键；不传则不做幂等保护 */
  clientMessageId?: string | null;
  batchId?: string | null;
};

export async function appendCustomerMessage(
  ctx: AuthContext,
  input: AppendInput,
): Promise<AppendMessageResult> {
  const customer = await requireCustomer(ctx, input.customerId);
  const content = input.content.trim();
  if (!content) throw badRequest('消息内容不能为空');

  // 幂等第一道：先查后写（覆盖绝大多数重复提交）
  if (input.clientMessageId) {
    const existing = await prisma.message.findFirst({
      where: { tenantId: ctx.tenantId, clientMessageId: input.clientMessageId },
    });
    if (existing) return { message: existing, deduplicated: true };
  }

  try {
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          tenantId: ctx.tenantId,
          customerId: customer.id,
          role: 'CUSTOMER',
          content,
          clientMessageId: input.clientMessageId ?? null,
          batchId: input.batchId ?? null,
        },
      });

      const now = created.createdAt;

      // 客户"最近活动"用于列表排序；状态表记录客户最后一次说话的准确时间（Follow-up 判定依据）
      await tx.customer.update({ where: { id: customer.id }, data: { updatedAt: now } });
      await tx.customerState.update({
        where: { customerId: customer.id },
        data: {
          lastContactAt: now,
          lastCustomerMessageAt: now,
          // 客户再次发言 = 上一轮"静默"结束，跟进计数归零，开始新的跟进周期。
          // 否则跟进次数会跨多次对话累计，几次之后就再也不提醒了。
          followUpCount: 0,
        },
      });

      return created;
    });

    return { message, deduplicated: false };
  } catch (error) {
    // 幂等第二道：并发下唯一索引兜底（两个请求同时通过了"先查"）
    if (isUniqueViolation(error) && input.clientMessageId) {
      const existing = await prisma.message.findFirst({
        where: { tenantId: ctx.tenantId, clientMessageId: input.clientMessageId },
      });
      if (existing) return { message: existing, deduplicated: true };
    }
    throw error;
  }
}

/** 销售发送消息（M3 使用）：同样先校验客户在作用域内 */
export async function appendSalesMessage(
  ctx: AuthContext,
  input: AppendInput,
): Promise<AppendMessageResult> {
  const customer = await requireCustomer(ctx, input.customerId);
  const content = input.content.trim();
  if (!content) throw badRequest('回复内容不能为空');

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        tenantId: ctx.tenantId,
        customerId: customer.id,
        role: 'SALES',
        content,
        senderUserId: ctx.userId,
        batchId: input.batchId ?? null,
      },
    });

    const now = created.createdAt;
    await tx.customer.update({ where: { id: customer.id }, data: { updatedAt: now } });
    await tx.customerState.update({
      where: { customerId: customer.id },
      data: { lastContactAt: now },
    });

    return created;
  });

  return { message, deduplicated: false };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * 销售确认发送 AI 建议（核心任务 4 的落点）。
 *
 * 语义要点：
 *  1) 真正入库的是一线销售**最终确认的文本**（可能已在建议基础上改过），而不是 AI 的原始回复；
 *  2) 发送后这条消息进入聊天记录，**参与下一轮 AI 判断**（历史对话里会出现它）；
 *  3) 建议上留痕：sentMessageId / finalReply / sentAt —— 于是"AI 建议了什么、人改成了什么、
 *     最后发出去的是什么"三者可追溯，也就能统计采纳率与修改率。
 */
export async function sendSuggestionReply(
  ctx: AuthContext,
  suggestionId: string,
  reply: string,
): Promise<{ message: Awaited<ReturnType<typeof prisma.message.create>>; edited: boolean }> {
  const suggestion = await prisma.aiSuggestion.findFirst({
    where: { id: suggestionId, tenantId: ctx.tenantId },
  });
  if (!suggestion) throw notFound('AI 建议');

  // 复用客户作用域校验：拿到不属于自己的建议时同样 404
  const customer = await requireCustomer(ctx, suggestion.customerId);

  const content = reply.trim();
  if (!content) throw badRequest('回复内容不能为空');

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        tenantId: ctx.tenantId,
        customerId: customer.id,
        role: 'SALES',
        content,
        senderUserId: ctx.userId,
        batchId: suggestion.batchId,
      },
    });

    await tx.customer.update({ where: { id: customer.id }, data: { updatedAt: created.createdAt } });
    await tx.customerState.update({
      where: { customerId: customer.id },
      data: { lastContactAt: created.createdAt },
    });
    await tx.aiSuggestion.update({
      where: { id: suggestionId },
      data: {
        sentMessageId: created.id,
        finalReply: content,
        sentAt: created.createdAt,
      },
    });

    return created;
  });

  return { message, edited: content !== suggestion.reply };
}
