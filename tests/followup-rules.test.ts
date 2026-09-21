import { describe, expect, it } from 'vitest';

import { evaluateFollowUp, type FollowUpInput } from '@/lib/agent/followup';

/**
 * Follow-up 判定矩阵单测。
 *
 * 题目问的四个问题（什么情况跟进/什么情况不跟进/成交怎么办/转人工怎么办/是否限制次数）
 * 全部收敛在这一个纯函数里，因此这里逐条钉死 9 条规则。
 */

const NOW = new Date('2026-09-20T12:00:00Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function makeInput(overrides: Partial<FollowUpInput> = {}): FollowUpInput {
  return {
    leadStage: 'DISCOVERY',
    needHuman: false,
    lastCustomerMessageAt: minutesAgo(30),
    lastSalesMessageAt: null,
    followUpCount: 0,
    lastFollowUpAt: null,
    hasPendingTask: false,
    now: NOW,
    idleMinutes: 2,
    maxAttempts: 2,
    cooldownMinutes: 4,
    ...overrides,
  };
}

describe('evaluateFollowUp — 跟进判定矩阵', () => {
  it('规则⑨：静默超时且无其它阻碍 → 应当跟进', () => {
    const decision = evaluateFollowUp(makeInput());
    expect(decision.shouldFollowUp).toBe(true);
    expect(decision.rule).toBe('SHOULD_FOLLOW_UP');
  });

  it('规则①：已成交客户 → 不跟进', () => {
    const decision = evaluateFollowUp(makeInput({ leadStage: 'WON' }));
    expect(decision.shouldFollowUp).toBe(false);
    expect(decision.rule).toBe('TERMINAL_STAGE');
  });

  it('规则①：已流失客户 → 不跟进', () => {
    const decision = evaluateFollowUp(makeInput({ leadStage: 'LOST' }));
    expect(decision.rule).toBe('TERMINAL_STAGE');
  });

  it('规则②：已标记需人工 → 不跟进（交给销售，系统不催）', () => {
    const decision = evaluateFollowUp(makeInput({ needHuman: true }));
    expect(decision.shouldFollowUp).toBe(false);
    expect(decision.rule).toBe('HUMAN_PENDING');
  });

  it('规则③：已有待处理跟进任务 → 不重复创建', () => {
    const decision = evaluateFollowUp(makeInput({ hasPendingTask: true }));
    expect(decision.rule).toBe('PENDING_TASK');
  });

  it('规则④：达到跟进次数上限 → 停止自动跟进', () => {
    const decision = evaluateFollowUp(makeInput({ followUpCount: 2, maxAttempts: 2 }));
    expect(decision.shouldFollowUp).toBe(false);
    expect(decision.rule).toBe('MAX_ATTEMPTS');
  });

  it('规则⑤：距上次跟进未过冷却期 → 不跟进', () => {
    const decision = evaluateFollowUp(makeInput({ lastFollowUpAt: minutesAgo(1), cooldownMinutes: 4 }));
    expect(decision.shouldFollowUp).toBe(false);
    expect(decision.rule).toBe('COOLDOWN');
  });

  it('规则⑤：已过冷却期 → 允许跟进', () => {
    const decision = evaluateFollowUp(makeInput({ lastFollowUpAt: minutesAgo(10), cooldownMinutes: 4 }));
    expect(decision.shouldFollowUp).toBe(true);
  });

  it('规则⑥：客户从未说过话 → 不存在"未回复"', () => {
    const decision = evaluateFollowUp(makeInput({ lastCustomerMessageAt: null }));
    expect(decision.rule).toBe('NEVER_SPOKE');
  });

  it('规则⑦：客户刚说过话（未达静默阈值）→ 不跟进', () => {
    const decision = evaluateFollowUp(makeInput({ lastCustomerMessageAt: minutesAgo(1) }));
    expect(decision.shouldFollowUp).toBe(false);
    expect(decision.rule).toBe('NOT_IDLE');
  });

  it('规则⑧：销售刚回过话（在冷却期内）→ 先等一下', () => {
    const decision = evaluateFollowUp(makeInput({ lastSalesMessageAt: minutesAgo(2), cooldownMinutes: 4 }));
    expect(decision.shouldFollowUp).toBe(false);
    expect(decision.rule).toBe('JUST_REPLIED');
  });

  it('规则⑧ 的边界：销售回过话但已过冷却期 → 仍然应当跟进（报了价客户不吭声，正是该跟进的时候）', () => {
    const decision = evaluateFollowUp(makeInput({ lastSalesMessageAt: minutesAgo(20), cooldownMinutes: 4 }));
    expect(decision.shouldFollowUp).toBe(true);
    expect(decision.rule).toBe('SHOULD_FOLLOW_UP');
  });

  it('优先级：终态优先于其它一切条件', () => {
    const decision = evaluateFollowUp(
      makeInput({ leadStage: 'WON', needHuman: true, hasPendingTask: true, followUpCount: 99 }),
    );
    expect(decision.rule).toBe('TERMINAL_STAGE');
  });

  it('优先级：需人工优先于"次数上限"', () => {
    const decision = evaluateFollowUp(makeInput({ needHuman: true, followUpCount: 99 }));
    expect(decision.rule).toBe('HUMAN_PENDING');
  });
});
