import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAgent } from '@/lib/agent/pipeline';
import { unauthorized } from '@/lib/errors';
import { getApiAuth } from '@/server/auth';
import { jsonError, readJson } from '@/server/api';
import { configSchema } from '../route';

export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  customerId: z.string().trim().min(1),
  /** 假设的客户消息：用它做 A/B，不写库 */
  message: z.string().trim().min(1).max(500),
  /** 正在编辑（可能尚未保存）的规则草稿 */
  draft: configSchema,
});

/**
 * 规则试跑对比（**不落库**）。
 *
 * 同一个客户、同一段历史对话、同一句客户消息，分别在
 *   ① 当前已保存的规则  ② 你正在编辑的草稿规则
 * 下各跑一次判断，并排展示意图 / 阶段 / 下一步动作 / 是否转人工 / 引用规则 / 建议回复的差异。
 *
 * 这是核心任务 5「切换规则后 AI 判断确实受规则影响」最直接的证据，
 * 也是真实 SaaS 里"改规则前先看效果"的必要能力。
 */
export async function POST(request: Request) {
  try {
    const ctx = await getApiAuth();
    if (!ctx) throw unauthorized();

    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '参数不合法' },
        { status: 400 },
      );
    }

    const { customerId, message, draft } = parsed.data;

    const baseline = await runAgent({
      ctx,
      customerId,
      trigger: 'REGENERATE',
      dryRun: true,
      dryRunMessage: message,
    });

    const withDraft = await runAgent({
      ctx,
      customerId,
      trigger: 'REGENERATE',
      dryRun: true,
      dryRunMessage: message,
      ruleOverride: {
        rules: draft.rules,
        handoff: draft.handoff,
        tone: draft.tone,
        salesGoal: draft.salesGoal,
        forbidden: draft.forbidden,
      },
    });

    return NextResponse.json({
      message,
      baseline: {
        suggestion: baseline.suggestion,
        adjustments: baseline.adjustments,
        guardViolations: baseline.guardViolations,
        handoffNotes: baseline.handoffNotes,
      },
      draft: {
        suggestion: withDraft.suggestion,
        adjustments: withDraft.adjustments,
        guardViolations: withDraft.guardViolations,
        handoffNotes: withDraft.handoffNotes,
      },
      changed: {
        leadStage: baseline.suggestion.leadStage !== withDraft.suggestion.leadStage,
        nextAction: baseline.suggestion.nextAction !== withDraft.suggestion.nextAction,
        needHuman: baseline.suggestion.needHuman !== withDraft.suggestion.needHuman,
        reply: baseline.suggestion.reply !== withDraft.suggestion.reply,
      },
    });
  } catch (error) {
    return jsonError(error, 'tenant:trial-run');
  }
}
