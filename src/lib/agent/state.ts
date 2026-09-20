import type { LeadStage } from '@/generated/prisma/enums';
import { STAGE_ORDER, TERMINAL_STAGES } from '@/lib/types';
import type { AgentOutput } from './schema';

/**
 * Customer State 状态机（**只管销售阶段与意图**）—— 纯函数、无 IO、完全可单测。
 *
 * 职责边界（重要）：
 *   - 本文件：阶段怎么变（终态保护 / 阶段不回退）
 *   - handoff.ts：本轮要不要转人工（企业交接规则 + AI 建议）
 *   - pipeline.ts：把两者与**历史状态**合并（需人工标记只升不降）
 *
 * 为什么"AI 判断"与"状态事实"必须分开：模型输出的是**建议**，数据库里的状态是**事实**。
 * 一旦模型漂移（把终态改回去、把阶段往回退），历史状态就不可信了 —— 而销售漏斗的正确性
 * 恰恰依赖于状态可信。因此模型只能"建议"，写入权由确定性代码掌握。
 */

export type StateSnapshot = {
  leadStage: LeadStage;
  intent: string;
};

export type StageTransition = {
  next: StateSnapshot;
  adjustments: StateAdjustment[];
};

export type StateAdjustment = {
  field: 'lead_stage' | 'need_human' | 'next_action';
  suggested: string;
  adopted: string;
  rule: string;
  note: string;
};

export function computeStageTransition(
  current: StateSnapshot,
  output: AgentOutput,
): StageTransition {
  const adjustments: StateAdjustment[] = [];
  let leadStage: LeadStage = output.lead_stage;

  const currentIsTerminal = TERMINAL_STAGES.includes(current.leadStage);
  const suggestedIsTerminal = TERMINAL_STAGES.includes(output.lead_stage);

  if (currentIsTerminal && output.lead_stage !== current.leadStage) {
    leadStage = current.leadStage;
    adjustments.push({
      field: 'lead_stage',
      suggested: output.lead_stage,
      adopted: current.leadStage,
      rule: 'TERMINAL_LOCK',
      note: '已是终态（成交/流失），AI 不得改动，需人工确认后才能变更',
    });
  } else if (!currentIsTerminal && suggestedIsTerminal) {
    // AI 只能"建议"成交或流失，不能直接写终态
    leadStage =
      STAGE_ORDER[current.leadStage] >= STAGE_ORDER.HIGH_INTENT ? current.leadStage : 'HIGH_INTENT';
    adjustments.push({
      field: 'lead_stage',
      suggested: output.lead_stage,
      adopted: leadStage,
      rule: 'TERMINAL_REQUIRES_HUMAN',
      note: '终态属于人工动作，AI 仅提示，阶段暂存为高意向',
    });
  } else if (STAGE_ORDER[output.lead_stage] < STAGE_ORDER[current.leadStage]) {
    leadStage = current.leadStage;
    adjustments.push({
      field: 'lead_stage',
      suggested: output.lead_stage,
      adopted: current.leadStage,
      rule: 'NO_REGRESSION',
      note: '阶段不允许自动回退，如需回退请人工判断',
    });
  }

  return {
    next: { leadStage, intent: output.customer_intent },
    adjustments,
  };
}

/** 从数据库 Json 字段安全解析状态修正记录（前端展示与审计用） */
export function parseAdjustments(value: unknown): StateAdjustment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.field !== 'string' || typeof record.note !== 'string') return [];
    return [
      {
        field: record.field as StateAdjustment['field'],
        suggested: String(record.suggested ?? ''),
        adopted: String(record.adopted ?? ''),
        rule: String(record.rule ?? ''),
        note: record.note,
      },
    ];
  });
}
