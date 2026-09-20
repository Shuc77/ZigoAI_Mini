'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Assignable = { id: string; name: string };

export function NewCustomerForm({ assignable }: { assignable: Assignable[] }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    handle: '',
    phone: '',
    source: '',
    note: '',
    assigneeId: '',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          handle: form.handle,
          phone: form.phone || null,
          source: form.source || null,
          note: form.note || null,
          assigneeId: form.assigneeId || null,
        }),
      });
      const data = (await response.json()) as { customer?: { id: string }; message?: string };

      if (!response.ok || !data.customer) {
        setError(data.message ?? '创建失败');
        return;
      }

      router.push(`/customers/${data.customer.id}`);
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setPending(false);
    }
  }

  const inputClass =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">客户姓名 *</label>
          <input className={inputClass} value={form.name} onChange={(e) => update('name', e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">微信号 / 联系人标识 *</label>
          <input className={inputClass} value={form.handle} onChange={(e) => update('handle', e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">电话</label>
          <input className={inputClass} value={form.phone} onChange={(e) => update('phone', e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">来源</label>
          <input
            className={inputClass}
            value={form.source}
            onChange={(e) => update('source', e.target.value)}
            placeholder="例如：朋友圈广告 / 400 电话"
          />
        </div>
      </div>

      {assignable.length > 0 ? (
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">负责人</label>
          <select className={inputClass} value={form.assigneeId} onChange={(e) => update('assigneeId', e.target.value)}>
            <option value="">（默认：我自己）</option>
            {assignable.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">备注</label>
        <textarea className={inputClass} rows={3} value={form.note} onChange={(e) => update('note', e.target.value)} />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
        >
          {pending ? '创建中…' : '创建客户'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 transition hover:border-slate-300"
        >
          取消
        </button>
      </div>
    </form>
  );
}
