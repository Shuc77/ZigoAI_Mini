import type { LeadStage } from '@/generated/prisma/enums';
import { STAGE_ORDER, TERMINAL_STAGES } from '@/lib/types';
import type { AgentOutput } from './schema';

/**
 * Customer State 状态机 —— **纯函数，无 IO**，因此可以完全用单元测试覆盖。
 *
 * 为什么要把"AI 判断"和"状态变更"分开（这是本项目最重要的设计决策之一）：
 *   模型输出的是**建议**，数据库里的状态是**事实**。两者之间的落差必须由确定性代码来裁决，
 *   否则一旦模型漂移（把终态改回去、把阶段往回退、把"需人工"抹掉），历史状态就不可信了。
 *
 * 三条硬规则：
 *   R-A 终态保护：WON/LOST 是终态，AI 不能改动，只能由人工确认后写入
 *   R-B 阶段不回退：阶段可以保持或前进；需要回退说明出现了新情况，交由人工判断
 *   R-C 需人工标记只升不降：AI 只能"升级"为需人工介入，解除必须由人工操作完成
 *
 * 每一次被系统修正的地方都会记入 adjustments，前端会显示成
 * "AI 建议 X → 系统采纳 Y（原因）"，这样答辩时可以明确区分"模型的判断"与"系统的约束"。
 */

export type StateSnapshot = {
  leadStage: LeadStage;
  intent: string;
  needHuman: boolean;
  humanReason: string | null;
};

export type StateAdjustment = {
  field: 'lead_stage' | 'need_human';
  suggested: string;
  adopted: string;
  rule: string;
  note: string;
};

export type StateTransition = {
  next: StateSnapshot;
  adjustments: StateAdjustment[];
};

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

export function computeStateTransition(
  current: StateSnapshot,
  output: AgentOutput,
): StateTransition {
  const adjustments: StateAdjustment[] = [];

  // ---- R-A / R-B：销售阶段 ------------------------------------------------
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
    leadStage = STAGE_ORDER[current.leadStage] >= STAGE_ORDER.HIGH_INTENT ? current.leadStage : 'HIGH_INTENT';
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

  // ---- R-C：是否需人工介入 -------------------------------------------------
  let needHuman = current.needHuman || output.need_human || adjustments.some((a) => a.rule === 'TERMINAL_REQUIRES_HUMAN');
  let humanReason = current.humanReason;

  if (output.need_human || adjustments.some((a) => a.rule === 'TERMINAL_REQUIRES_HUMAN')) {
    humanReason = output.human_reason ?? current.humanReason ?? 'AI 建议人工介入';
  }

  if (current.needHuman && !needHuman) {
    // 理论上不会发生（上面用了 || ），保留分支以表达语义：解除标记只能由人工完成
    needHuman = true;
    adjustments.push({
      field: 'need_human',
      suggested: 'false',
      adopted: 'true',
      rule: 'HUMAN_FLAG_STICKY',
      note: 'AI 认为可以不转人工，但已标记的介入状态需人工处理完成后解除',
    });
  }

  if (!current.needHuman && output.need_human) {
    adjustments.push({
      field: 'need_human',
      suggested: 'false',
      adopted: 'true',
      rule: 'HUMAN_ESCALATION',
      note: `AI 建议人工介入：${humanReason ?? '未说明'}`,
    });
  }

  return {
    next: {
      leadStage,
      intent: output.customer_intent,
      needHuman,
      humanReason: needHuman ? humanReason : null,
    },
    adjustments,
  };
}
