'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const DEMO_ACCOUNTS = [
  'sales@lemeng.demo',
  'manager@lemeng.demo',
  'sales@jixie.demo',
  'manager@jixie.demo',
];

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('sales@lemeng.demo');
  const [password, setPassword] = useState('Zigo@2026');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(data.message ?? '登录失败');
        return;
      }
      router.push('/customers');
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="email">
          邮箱
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          required
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          required
        />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? '登录中…' : '登录'}
      </button>

      <div className="flex flex-wrap gap-2 pt-1">
        {DEMO_ACCOUNTS.map((account) => (
          <button
            key={account}
            type="button"
            onClick={() => {
              setEmail(account);
              setPassword('Zigo@2026');
            }}
            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600"
          >
            {account}
          </button>
        ))}
      </div>
    </form>
  );
}
