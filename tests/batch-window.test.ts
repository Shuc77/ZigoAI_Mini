import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BATCH_FAST_WINDOW_MS,
  DEFAULT_BATCH_WINDOW_MS,
  looksLikeQuestion,
  resolveBatchWindow,
} from '@/lib/agent/batch-window';

/**
 * 聚合窗口单测：把"客户说完了没有"的估计钉死。
 *
 * 为什么这组断言值钱：窗口同时决定两件互相拉扯的事 ——
 *   ① 销售要等多久才能看到判断（响应感）
 *   ② 客户连发的消息能不能被合并成一次判断（完整度）
 * 这两个目标很容易在改参数时被无意破坏，所以必须逐档钉死，
 * 并额外断言"设成同值即等价于旧的固定窗口"这条退路一直有效。
 */

const BASE = 8_000;
const FAST = 2_000;

function windowOf(lastContent: string, messageCount = 1) {
  return resolveBatchWindow({
    lastContent,
    messageCount,
    baseWindowMs: BASE,
    fastWindowMs: FAST,
  });
}

describe('looksLikeQuestion', () => {
  it('以问号结尾即为问句（中英文问号都算）', () => {
    expect(looksLikeQuestion('你们周末有课吗？')).toBe(true);
    expect(looksLikeQuestion('how much?')).toBe(true);
    expect(looksLikeQuestion('  多少钱 ？ ')).toBe(true);
  });

  it('命中明确诉求词也算"在等答案"，即使没有问号', () => {
    expect(looksLikeQuestion('年卡多少钱')).toBe(true);
    expect(looksLikeQuestion('想了解下课程')).toBe(true);
    expect(looksLikeQuestion('怎么报名')).toBe(true);
    // 中文里常见的"开场即等待"，没有问号也是问句
    expect(looksLikeQuestion('在吗')).toBe(true);
    expect(looksLikeQuestion('有人吗')).toBe(true);
    expect(looksLikeQuestion('你们周末有课吗')).toBe(true);
    expect(looksLikeQuestion('贵不贵呢')).toBe(true);
  });

  it('陈述句不误判（宁可退回长窗口，也不要抢答）', () => {
    expect(looksLikeQuestion('我考虑一下')).toBe(false);
    expect(looksLikeQuestion('昨天去看了别家的课')).toBe(false);
    expect(looksLikeQuestion('嗯嗯好的')).toBe(false);
    expect(looksLikeQuestion('   ')).toBe(false);
  });
});

describe('resolveBatchWindow', () => {
  it('问句 → 最短窗口（客户在等答案）', () => {
    const { windowMs, reason } = windowOf('你们年卡多少钱？', 1);
    expect(reason).toBe('QUESTION');
    expect(windowMs).toBe(FAST);
  });

  it('客户连发多条（非问句）→ 中间窗口，仍留合并余地', () => {
    const { windowMs, reason } = windowOf('我昨天去看了别家的课', 3);
    expect(reason).toBe('FOLLOW_UP');
    expect(windowMs).toBeGreaterThan(FAST);
    expect(windowMs).toBeLessThan(BASE);
  });

  it('单条陈述 → 保持原来的长窗口（不抢答）', () => {
    const { windowMs, reason } = windowOf('我考虑一下', 1);
    expect(reason).toBe('STATEMENT');
    expect(windowMs).toBe(BASE);
  });

  it('问句优先级高于连发：客户最后一句在等答案就按问句走', () => {
    expect(windowOf('你们年卡多少钱？', 4).reason).toBe('QUESTION');
    // 即便前面已经连发了好几条，最后一句是问句时窗口仍是最短的
    expect(windowOf('有人吗', 5).windowMs).toBe(FAST);
  });

  it('无论哪一档，都不会超过单条陈述的长窗口', () => {
    for (const content of ['多少钱？', '想了解', '我考虑一下', '']) {
      for (const count of [1, 2, 9]) {
        expect(windowOf(content, count).windowMs).toBeLessThanOrEqual(BASE);
      }
    }
  });

  it('把 fast 设成与 base 相同 → 精确退回旧的固定窗口行为', () => {
    const fixed = { baseWindowMs: BASE, fastWindowMs: BASE };
    for (const content of ['多少钱？', '我考虑一下', '想了解']) {
      for (const count of [1, 3]) {
        const result = resolveBatchWindow({ lastContent: content, messageCount: count, ...fixed });
        expect(result.windowMs).toBe(BASE);
      }
    }
  });

  it('fast 大于 base 时以 base 为准（配置写错也不会拖慢）', () => {
    const result = resolveBatchWindow({
      lastContent: '多少钱？',
      messageCount: 1,
      baseWindowMs: BASE,
      fastWindowMs: 30_000,
    });
    expect(result.windowMs).toBe(BASE);
  });

  it('不传参数时用默认值（生产默认 8s / 2s）', () => {
    expect(DEFAULT_BATCH_WINDOW_MS).toBe(8_000);
    expect(DEFAULT_BATCH_FAST_WINDOW_MS).toBe(2_000);
    expect(resolveBatchWindow({ lastContent: '多少钱？', messageCount: 1 }).windowMs).toBe(2_000);
    expect(resolveBatchWindow({ lastContent: '我考虑一下', messageCount: 1 }).windowMs).toBe(8_000);
  });
});
