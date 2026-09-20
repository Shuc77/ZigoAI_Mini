import { prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { parseStringList, parseTenantRules, type AuthContext, type TenantRules } from '@/lib/types';
import { assertManager } from '@/server/auth';

/**
 * 企业（租户）仓储层。
 * 注意：企业配置是"AI 判断的输入之一"，因此它也必须在租户作用域内被读取与修改。
 */

export async function getTenant(ctx: AuthContext) {
  const tenant = await prisma.tenant.findUnique({ where: { id: ctx.tenantId } });
  if (!tenant) throw notFound('企业');
  return tenant;
}

export type TenantConfig = {
  id: string;
  name: string;
  slug: string;
  salesGoal: string;
  tone: string;
  rules: TenantRules;
  forbidden: string[];
};

export async function getTenantConfig(ctx: AuthContext): Promise<TenantConfig> {
  const tenant = await getTenant(ctx);
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    salesGoal: tenant.salesGoal,
    tone: tenant.tone,
    rules: parseTenantRules(tenant.rules),
    forbidden: parseStringList(tenant.forbidden),
  };
}

export type UpdateTenantConfigInput = {
  salesGoal: string;
  tone: string;
  rules: Array<{ id: string; text: string; guard?: string }>;
  forbidden: string[];
};

/** 修改企业销售规则：仅主管，且只能改自己企业 */
export async function updateTenantConfig(ctx: AuthContext, input: UpdateTenantConfigInput) {
  assertManager(ctx);

  return prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: {
      salesGoal: input.salesGoal,
      tone: input.tone,
      rules: input.rules,
      forbidden: input.forbidden,
    },
  });
}
