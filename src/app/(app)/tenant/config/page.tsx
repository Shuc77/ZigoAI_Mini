import { requirePageAuth } from '@/server/auth';
import { listCustomers } from '@/server/repositories/customers';
import { getTenantConfig } from '@/server/repositories/tenants';
import { TenantConfigEditor } from './tenant-config-editor';

export const metadata = { title: '企业规则 · ZigoAI Mini' };

export default async function TenantConfigPage() {
  const ctx = await requirePageAuth();
  const [config, customers] = await Promise.all([getTenantConfig(ctx), listCustomers(ctx)]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">企业规则</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          这里配置的规则与交接标准，会直接影响 AI 对每一个客户的判断与话术。
        </p>
      </div>

      <TenantConfigEditor
        tenantName={config.name}
        canEdit={ctx.role === 'MANAGER'}
        initialConfig={{
          salesGoal: config.salesGoal,
          tone: config.tone,
          rules: config.rules.map((rule) => ({
            id: rule.id,
            text: rule.text,
            guard: rule.guard,
          })),
          forbidden: config.forbidden,
          handoff: config.handoff,
        }}
        customers={customers.map((customer) => ({ id: customer.id, name: customer.name }))}
      />
    </div>
  );
}
