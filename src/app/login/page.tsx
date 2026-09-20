import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth/session';
import { LoginForm } from './login-form';

export const metadata = { title: '登录 · ZigoAI Mini' };

export default async function LoginPage() {
  const ctx = await readSession();
  if (ctx) redirect('/customers');

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">ZigoAI Mini</h1>
          <p className="mt-1 text-sm text-slate-500">AI Sales Agent · 让 AI 帮销售判断下一步该做什么</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm />
        </div>

        <div className="mt-5 rounded-xl border border-slate-200 bg-white/70 p-4 text-xs text-slate-600">
          <div className="mb-2 font-medium text-slate-700">演示账号（密码统一 Zigo@2026，点击即可填入）</div>
          <ul className="space-y-1">
            <li>乐蒙亲子游泳 · 课程顾问 ── sales@lemeng.demo</li>
            <li>乐蒙亲子游泳 · 销售主管 ── manager@lemeng.demo</li>
            <li>机械之家 · 客户经理 ── sales@jixie.demo</li>
            <li>机械之家 · 销售主管 ── manager@jixie.demo</li>
          </ul>
          <p className="mt-2 text-slate-400">
            两个企业的销售规则不同，切换账号后同一个客户消息会得到不同的判断与话术。
          </p>
        </div>
      </div>
    </main>
  );
}
