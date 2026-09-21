import { describe, expect, it } from 'vitest';

import { computeStageTransition } from '@/lib/agent/state';
import { buildAgentOutputSchema, type AgentOutput } from '@/lib/agent/schema';

/**
 * Customer State 状态机单测。
 *
 * 这是整个系统"不完全信任模型"的核心落点：模型输出的是**建议**，写进数据库的必须是**事实**。
 * 因此三条硬规则必须被测试钉死：
 *   ① 终态保护       —— 已成交/已流失不允许 AI 改动
 *   ② 终态需人工确认 —— AI 不能直接把阶段写成 WON/LOST
 *   ③ 阶段不回退     —— 只能保持或前进
 */

function makeOutput(overrides: Partial<AgentOutput> = {}): AgentOutput {
  const schema = buildAgentOutputSchema('NEW');
  const base = schema.parse({
    customer_intent: '了解产品',
    intent_detail: '',
    lead_stage: 'NEW',
    next_action: '继续探需',
    reply: '您好，请问您想了解哪方面？',
    reason: '客户刚进入对话',
    need_human: false,
    human_reason: null,
    rules_applied: [],
  });
  return { ...base, ...overrides };
}

describe('computeStageTransition — 阶段状态机', () => {
  /*
   * AI 建议终态时必须把"这件事"带出来 —— 拦下它只是第一步，
   * 真正的闭环是"有人被通知去确认"（否则客户可能明天就去别家了）。
   */
  describe('AI 建议终态时要把信号交给交接策略', () => {
    it('AI 建议流失 → 拦下阶段，同时带出 suggestedTerminal=LOST', () => {
      const result = computeStageTransition(
        { leadStage: 'HIGH_INTENT', intent: '预约' },
        makeOutput({ lead_stage: 'LOST', customer_intent: '拒绝' }),
      );

      expect(result.next.leadStage).toBe('HIGH_INTENT');
      expect(result.suggestedTerminal).toBe('LOST');
      expect(result.adjustments[0].rule).toBe('TERMINAL_REQUIRES_HUMAN');
    });

    it('AI 建议成交 → 同样带出 suggestedTerminal=WON（成交也是人工动作）', () => {
      const result = computeStageTransition(
        { leadStage: 'HIGH_INTENT', intent: '询价' },
        makeOutput({ lead_stage: 'WON' }),
      );

      expect(result.suggestedTerminal).toBe('WON');
    });

    it('普通阶段推进时不带终态信号', () => {
      expect(
        computeStageTransition({ leadStage: 'NEW', intent: '待判断' }, makeOutput({ lead_stage: 'DISCOVERY' }))
          .suggestedTerminal,
      ).toBeNull();
    });

    it('已是终态时由 TERMINAL_LOCK 处理，不再重复升级人工', () => {
      const result = computeStageTransition(
        { leadStage: 'LOST', intent: '拒绝' },
        makeOutput({ lead_stage: 'WON' }),
      );

      expect(result.next.leadStage).toBe('LOST');
      expect(result.suggestedTerminal).toBeNull();
      expect(result.adjustments[0].rule).toBe('TERMINAL_LOCK');
    });
  });

  it('阶段正常前进：不做任何修正', () => {
    const result = computeStageTransition(
      { leadStage: 'NEW', intent: '待判断' },
      makeOutput({ lead_stage: 'DISCOVERY' }),
    );

    expect(result.next.leadStage).toBe('DISCOVERY');
    expect(result.adjustments).toHaveLength(0);
  });

  it('阶段保持不变：不做任何修正', () => {
    const result = computeStageTransition(
      { leadStage: 'INTERESTED', intent: '询价' },
      makeOutput({ lead_stage: 'INTERESTED' }),
    );

    expect(result.next.leadStage).toBe('INTERESTED');
    expect(result.adjustments).toHaveLength(0);
  });

  it('硬规则①：已成交客户，AI 建议改成已流失 → 被拦下（TERMINAL_LOCK）', () => {
    const result = computeStageTransition(
      { leadStage: 'WON', intent: '购买' },
      makeOutput({ lead_stage: 'LOST', customer_intent: '犹豫' }),
    );

    expect(result.next.leadStage).toBe('WON');
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].rule).toBe('TERMINAL_LOCK');
    expect(result.adjustments[0].suggested).toBe('LOST');
    expect(result.adjustments[0].adopted).toBe('WON');
  });

  it('硬规则①：已流失客户，AI 建议改成已成交 → 同样被拦下', () => {
    const result = computeStageTransition(
      { leadStage: 'LOST', intent: '犹豫' },
      makeOutput({ lead_stage: 'WON', customer_intent: '购买' }),
    );

    expect(result.next.leadStage).toBe('LOST');
    expect(result.adjustments[0].rule).toBe('TERMINAL_LOCK');
  });

  it('硬规则②：AI 不能直接写终态，阶段最多暂存为高意向并需人工确认', () => {
    const result = computeStageTransition(
      { leadStage: 'INTERESTED', intent: '询价' },
      makeOutput({ lead_stage: 'WON', customer_intent: '购买' }),
    );

    expect(result.next.leadStage).toBe('HIGH_INTENT');
    expect(result.adjustments[0].rule).toBe('TERMINAL_REQUIRES_HUMAN');
  });

  it('硬规则②：已是高意向时，AI 建议终态 → 保持高意向（不后退）', () => {
    const result = computeStageTransition(
      { leadStage: 'HIGH_INTENT', intent: '询价' },
      makeOutput({ lead_stage: 'LOST' }),
    );

    expect(result.next.leadStage).toBe('HIGH_INTENT');
    expect(result.adjustments[0].rule).toBe('TERMINAL_REQUIRES_HUMAN');
  });

  it('硬规则③：阶段不允许自动回退（NO_REGRESSION）', () => {
    const result = computeStageTransition(
      { leadStage: 'HIGH_INTENT', intent: '询价' },
      makeOutput({ lead_stage: 'DISCOVERY', customer_intent: '犹豫' }),
    );

    expect(result.next.leadStage).toBe('HIGH_INTENT');
    expect(result.adjustments[0].rule).toBe('NO_REGRESSION');
  });

  it('意图直接采纳 AI 的判断', () => {
    const result = computeStageTransition(
      { leadStage: 'NEW', intent: '待判断' },
      makeOutput({ customer_intent: '投诉' }),
    );

    expect(result.next.intent).toBe('投诉');
  });
});
