import Link from 'next/link';
import { requirePageAuth } from '@/server/auth';
import { listAssignableUsers } from '@/server/repositories/customers';
import { NewCustomerForm } from './new-customer-form';

export const metadata = { title: '新建客户 · ZigoAI Mini' };

export default async function NewCustomerPage() {
  const ctx = await requirePageAuth();
  // 只有主管需要选负责人；销售创建的客户默认归属自己
  const assignable = ctx.role === 'MANAGER' ? await listAssignableUsers(ctx) : [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Link href="/customers" className="hover:text-indigo-600">
          ← 客户列表
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700">新建客户</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <h1 className="text-lg font-semibold tracking-tight">新建客户</h1>
        <p className="mt-1 mb-5 text-sm text-slate-500">
          创建后会同时生成初始销售状态（阶段：新客户），随后即可录入客户消息并让 AI 判断。
        </p>
        <NewCustomerForm assignable={assignable} />
      </div>
    </div>
  );
}
