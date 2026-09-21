import { describe, expect, it } from 'vitest';

import { classifyCustomerForQueue, isActionable } from '@/lib/customer-queue';

/**
 * 待办队列排序规则单测。
 *
 * 为什么这组断言值钱：客户列表是销售每天打开的第一个页面，
 * 它的排序**决定了销售先处理谁**。这类"排序规则"最容易被后续改动悄悄改坏
 * （例如把终态也排到前面、或把静默判断的阈值接错），而且坏了不报错 —— 只是顺序变得没道理。
 */

const NOW = new Date('2026-09-21T12:00:00Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function classify(overrides: Partial<Parameters<typeof classifyCustomerForQueue>[0]> = {}) {
  return classifyCustomerForQueue({
    needHuman: false,
    leadStage: 'DISCOVERY',
    lastCustomerMessageAt: minutesAgo(1),
    idleMinutes: 2,
    now: NOW,
    ...overrides,
  });
}

describe('classifyCustomerForQueue', () => {
  it('标记需人工 → 最高优先级（人的事永远排最前）', () => {
    const result = classify({ needHuman: true });
    expect(result.bucket).toBe('NEED_HUMAN');
    expect(result.priority).toBe(0);
    expect(isActionable(result.bucket)).toBe(true);
  });

  it('终态客户即使需人工也仍然排在最前（成交后要人工确认，那也是一件待办）', () => {
    const result = classify({ needHuman: true, leadStage: 'WON' });
    expect(result.bucket).toBe('NEED_HUMAN');
    expect(result.priority).toBe(0);
  });

  it('终态且不需人工 → 沉底，不再打扰', () => {
    expect(classify({ leadStage: 'WON', lastCustomerMessageAt: minutesAgo(1) }).bucket).toBe('CLOSED');
    expect(classify({ leadStage: 'LOST' }).bucket).toBe('CLOSED');
    expect(isActionable(classify({ leadStage: 'WON' }).bucket)).toBe(false);
  });

  it('客户静默超过阈值 → 该跟进', () => {
    const result = classify({ lastCustomerMessageAt: minutesAgo(30), idleMinutes: 2 });
    expect(result.bucket).toBe('FOLLOW_UP');
    expect(result.hint).toContain('30');
  });

  it('客户刚说完话 → 待回复（最该立刻处理）', () => {
    const result = classify({ lastCustomerMessageAt: minutesAgo(1), idleMinutes: 2 });
    expect(result.bucket).toBe('NEEDS_REPLY');
    expect(isActionable(result.bucket)).toBe(true);
  });

  it('阈值边界：刚好等于阈值算该跟进，差一点算待回复', () => {
    expect(classify({ lastCustomerMessageAt: minutesAgo(2), idleMinutes: 2 }).bucket).toBe('FOLLOW_UP');
    expect(classify({ lastCustomerMessageAt: minutesAgo(1.9), idleMinutes: 2 }).bucket).toBe('NEEDS_REPLY');
  });

  it('客户从未说过话 → 正常（不算待办）', () => {
    const result = classify({ lastCustomerMessageAt: null });
    expect(result.bucket).toBe('NORMAL');
    expect(isActionable(result.bucket)).toBe(false);
  });

  it('优先级严格有序：需人工 < 该跟进 < 待回复 < 待判断 < 已结束', () => {
    const priorities = [
      classify({ needHuman: true }).priority,
      classify({ lastCustomerMessageAt: minutesAgo(30) }).priority,
      classify({ lastCustomerMessageAt: minutesAgo(1) }).priority,
      classify({ lastCustomerMessageAt: null }).priority,
      classify({ leadStage: 'WON' }).priority,
    ];
    for (let i = 1; i < priorities.length; i += 1) {
      expect(priorities[i]).toBeGreaterThan(priorities[i - 1]);
    }
  });

  it('每个桶都给得出可展示的中文标签与理由（界面不能出现空白说明）', () => {
    for (const input of [
      { needHuman: true },
      { leadStage: 'WON' as const },
      { lastCustomerMessageAt: minutesAgo(30) },
      { lastCustomerMessageAt: minutesAgo(1) },
      { lastCustomerMessageAt: null },
    ]) {
      const result = classify(input);
      expect(result.label.length).toBeGreaterThan(0);
      expect(result.hint.length).toBeGreaterThan(0);
    }
  });
});
