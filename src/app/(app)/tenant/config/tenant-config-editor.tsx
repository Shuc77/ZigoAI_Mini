'use client';

import { useState } from 'react';

import type { LeadStage } from '@/generated/prisma/enums';
import type { HandoffConfig } from '@/lib/types';

type ConfigState = {
  salesGoal: string;
  tone: string;
  rules: Array<{ id: string; text: string; guard?: string }>;
  forbidden: string[];
  handoff: HandoffConfig;
};

type TrialSuggestion = {
  customerIntent: string;
  intentDetail: string | null;
  leadStage: LeadStage;
  nextAction: string;
  reply: string;
  reason: string;
  needHuman: boolean;
  humanReason: string | null;
  rulesApplied: string[];
  ruleViolation: string | null;
};

type TrialSide = {
  suggestion: TrialSuggestion;
  adjustments: Array<{ field: string; suggested: string; adopted: string; rule: string; note: string }>;
  guardViolations: Array<{ ruleId: string; message: string }>;
  handoffNotes: string[];
};

type TrialResult = {
  baseline: TrialSide;
  draft: TrialSide;
  changed: { leadStage: boolean; nextAction: boolean; needHuman: boolean; reply: boolean };
};

const GUARD_OPTIONS = [
  { value: '', label: '（不启用机器校验）' },
  { value: 'FORBID_QUOTE_BEFORE_INTEREST', label: '校验：未表达兴趣前不得报价' },
  { value: 'FORBID_ABSOLUTE_PROMISE', label: '校验：不得使用绝对化承诺' },
  { value: 'REQUIRE_DOC_REQUEST_ON_DEVICE_INTENT', label: '校验：确认需求后须索取资料' },
];

const TRIGGER_LABELS: Array<{ key: keyof HandoffConfig['triggers']; label: string }> = [
  { key: 'complaint', label: '客户投诉 / 情绪明显不满' },
  { key: 'wantsHuman', label: '客户明确要求真人或电话沟通' },
  { key: 'aiUnsure', label: 'AI 无法确认答案 / 涉及未给出的政策' },
  { key: 'highValue', label: '出现明确成交信号（签约、付款、发票）' },
  { key: 'ruleConflict', label: '触发企业规则红线（规则守护判定违规）' },
  { key: 'churnRisk', label: '客户明确表示不继续（AI 建议置为流失，需人工确认）' },
  { key: 'dealClosing', label: 'AI 判断已成交（终态需人工确认）' },
];

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-500';

export function TenantConfigEditor({
  tenantName,
  canEdit,
  initialConfig,
  customers,
}: {
  tenantName: string;
  canEdit: boolean;
  initialConfig: ConfigState;
  customers: Array<{ id: string; name: string }>;
}) {
  const [config, setConfig] = useState<ConfigState>(initialConfig);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [trialCustomerId, setTrialCustomerId] = useState(customers[0]?.id ?? '');
  const [trialMessage, setTrialMessage] = useState('你们那边年卡大概多少钱？');
  const [trial, setTrial] = useState<TrialResult | null>(null);
  const [running, setRunning] = useState(false);

  function patch(next: Partial<ConfigState>) {
    setConfig((prev) => ({ ...prev, ...next }));
    setSaved(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/tenant/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(data.message ?? '保存失败');
        return;
      }
      setSaved('已保存，下一个客户消息就会按新规则判断');
    } catch {
      setError('网络异常，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function runTrial() {
    if (!trialCustomerId) return;
    setRunning(true);
    setError(null);
    setTrial(null);
    try {
      const response = await fetch('/api/tenant/config/trial-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: trialCustomerId, message: trialMessage, draft: config }),
      });
      const data = (await response.json()) as TrialResult & { message?: string };
      if (!response.ok) {
        setError(data.message ?? '试跑失败');
        return;
      }
      setTrial(data);
    } catch {
      setError('网络异常，请重试');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* 企业档案 */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-medium">企业档案</h2>
        <p className="mt-1 text-xs text-slate-500">
          {tenantName} · 这些内容会进入每一次 AI 判断的 system prompt
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">本企业销售目标</label>
            <textarea
              className={inputClass}
              rows={2}
              disabled={!canEdit}
              value={config.salesGoal}
              onChange={(e) => patch({ salesGoal: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">沟通语气要求</label>
            <input
              className={inputClass}
              disabled={!canEdit}
              value={config.tone}
              onChange={(e) => patch({ tone: e.target.value })}
            />
          </div>
        </div>
      </section>

      {/* 销售规则 */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-medium">销售规则</h2>
            <p className="mt-1 text-xs text-slate-500">
              规则会**逐条编号**注入提示词，AI 需在判断中回报引用了哪几条；
              勾选「校验」的规则还会被**规则守护**在生成后做确定性检查，违规会要求重写，仍违规则转人工。
            </p>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={() =>
                patch({
                  rules: [...config.rules, { id: `R${config.rules.length + 1}`, text: '' }],
                })
              }
              className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
            >
              添加规则
            </button>
          ) : null}
        </div>

        <div className="mt-4 space-y-3">
          {config.rules.map((rule, index) => (
            <div key={index} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="flex items-center gap-2">
                <input
                  className={`${inputClass} w-20 font-mono`}
                  disabled={!canEdit}
                  value={rule.id}
                  onChange={(e) => {
                    const rules = [...config.rules];
                    rules[index] = { ...rule, id: e.target.value };
                    patch({ rules });
                  }}
                />
                <input
                  className={inputClass}
                  disabled={!canEdit}
                  placeholder="规则内容，例如：客户未表达明确兴趣前，不主动报价"
                  value={rule.text}
                  onChange={(e) => {
                    const rules = [...config.rules];
                    rules[index] = { ...rule, text: e.target.value };
                    patch({ rules });
                  }}
                />
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => patch({ rules: config.rules.filter((_, i) => i !== index) })}
                    className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                  >
                    删除
                  </button>
                ) : null}
              </div>
              <select
                className={`${inputClass} mt-2`}
                disabled={!canEdit}
                value={rule.guard ?? ''}
                onChange={(e) => {
                  const rules = [...config.rules];
                  const guard = e.target.value || undefined;
                  rules[index] = { ...rule, guard };
                  patch({ rules });
                }}
              >
                {GUARD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {config.rules.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-400">还没有规则</p>
          ) : null}
        </div>
      </section>

      {/* 禁止事项 */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-medium">明确禁止</h2>
            <p className="mt-1 text-xs text-slate-500">例如"承诺具体折扣""承诺疗效"，AI 不得做出这类承诺</p>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={() => patch({ forbidden: [...config.forbidden, ''] })}
              className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
            >
              添加
            </button>
          ) : null}
        </div>

        <div className="mt-4 space-y-2">
          {config.forbidden.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                className={inputClass}
                disabled={!canEdit}
                value={item}
                onChange={(e) => {
                  const forbidden = [...config.forbidden];
                  forbidden[index] = e.target.value;
                  patch({ forbidden });
                }}
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => patch({ forbidden: config.forbidden.filter((_, i) => i !== index) })}
                  className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-2 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                >
                  删除
                </button>
              ) : null}
            </div>
          ))}
          {config.forbidden.length === 0 ? (
            <p className="py-2 text-center text-xs text-slate-400">没有配置禁止事项</p>
          ) : null}
        </div>
      </section>

      {/* 交接规则 */}
      <section className="rounded-xl border border-indigo-200 bg-white p-5">
        <h2 className="text-sm font-medium">交接规则（什么情况必须交给人工）</h2>
        <p className="mt-1 text-xs text-slate-500">
          这一块原本是硬编码在系统里的。不同企业的转人工标准差异极大（高客单业务"问价"就该人工核价，
          低客单业务则不必），因此它必须是企业级配置。AI 会按这里判断，系统还会做确定性兜底。
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {TRIGGER_LABELS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={config.handoff.triggers[key]}
                onChange={(e) =>
                  patch({
                    handoff: {
                      ...config.handoff,
                      triggers: { ...config.handoff.triggers, [key]: e.target.checked },
                    },
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              敏感词（命中即转人工，逗号分隔）
            </label>
            <input
              className={inputClass}
              disabled={!canEdit}
              value={config.handoff.keywords.join('，')}
              onChange={(e) =>
                patch({
                  handoff: {
                    ...config.handoff,
                    keywords: e.target.value
                      .split(/[,，\s]+/)
                      .map((k) => k.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              金额阈值（元，达到即转人工；留空表示不按金额判断）
            </label>
            <input
              className={inputClass}
              type="number"
              disabled={!canEdit}
              value={config.handoff.amountThreshold ?? ''}
              onChange={(e) =>
                patch({
                  handoff: {
                    ...config.handoff,
                    amountThreshold: e.target.value === '' ? null : Number(e.target.value),
                  },
                })
              }
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-slate-600">补充说明（给模型看）</label>
          <input
            className={inputClass}
            disabled={!canEdit}
            value={config.handoff.note}
            onChange={(e) => patch({ handoff: { ...config.handoff, note: e.target.value } })}
          />
        </div>
      </section>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
          {saved ? <span className="text-xs text-emerald-600">{saved}</span> : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500">只有销售主管（MANAGER）可以修改企业规则，你当前是只读视图。</p>
      )}

      {/* 试跑对比 */}
      {canEdit ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-medium">规则试跑对比（不落库）</h2>
          <p className="mt-1 text-xs text-slate-500">
            同一个客户、同一段历史对话、同一句客户消息，分别用「当前已保存的规则」与「你正在编辑的草稿」各判断一次，
            并排看差异 —— 确认无误再保存。
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <select
              className={inputClass}
              value={trialCustomerId}
              onChange={(e) => setTrialCustomerId(e.target.value)}
            >
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} sm:col-span-2`}
              value={trialMessage}
              onChange={(e) => setTrialMessage(e.target.value)}
              placeholder="假设客户发来的消息"
            />
          </div>

          <button
            type="button"
            onClick={() => void runTrial()}
            disabled={running || !trialCustomerId || trialMessage.trim().length === 0}
            className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-60"
          >
            {running ? '判断中…' : '运行对比'}
          </button>

          {trial ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <TrialColumn title="① 当前已保存的规则" side={trial.baseline} />
              <TrialColumn title="② 你正在编辑的草稿" side={trial.draft} highlight />
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}
    </div>
  );
}

function TrialColumn({
  title,
  side,
  highlight = false,
}: {
  title: string;
  side: TrialSide;
  highlight?: boolean;
}) {
  const { suggestion } = side;

  return (
    <div className={`rounded-lg border p-3 ${highlight ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-200 bg-slate-50/60'}`}>
      <div className="mb-2 text-xs font-medium text-slate-700">{title}</div>

      <dl className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded bg-white/70 px-2 py-1.5">
          <dt className="text-slate-500">客户意图</dt>
          <dd className="font-medium text-slate-800">{suggestion.customerIntent}</dd>
        </div>
        <div className="rounded bg-white/70 px-2 py-1.5">
          <dt className="text-slate-500">销售阶段</dt>
          <dd className="font-medium text-slate-800">{suggestion.leadStage}</dd>
        </div>
        <div className="rounded bg-white/70 px-2 py-1.5">
          <dt className="text-slate-500">下一步动作</dt>
          <dd className="font-medium text-slate-800">{suggestion.nextAction}</dd>
        </div>
        <div className="rounded bg-white/70 px-2 py-1.5">
          <dt className="text-slate-500">是否转人工</dt>
          <dd className="font-medium text-slate-800">
            {suggestion.needHuman ? `是（${suggestion.humanReason ?? '—'}）` : '否'}
          </dd>
        </div>
      </dl>

      <div className="mt-2 text-[11px] text-slate-500">
        引用规则：{suggestion.rulesApplied.length > 0 ? suggestion.rulesApplied.join('、') : '未引用'}
      </div>

      <div className="mt-2">
        <div className="text-[11px] text-slate-500">建议回复</div>
        <div className="prewrap mt-1 rounded bg-white px-2 py-1.5 text-xs leading-relaxed text-slate-800">
          {suggestion.reply}
        </div>
      </div>

      {side.guardViolations.length > 0 ? (
        <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
          规则守护违规：{side.guardViolations.map((v) => `${v.ruleId} ${v.message}`).join('；')}
        </div>
      ) : null}

      {side.handoffNotes.length > 0 ? (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          交接规则：{side.handoffNotes.join('；')}
        </div>
      ) : null}
    </div>
  );
}
