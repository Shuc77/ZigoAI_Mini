import { describe, expect, it } from 'vitest';

import { checkRuleGuards } from '@/lib/agent/guards';
import { applyHandoffPolicy, extractMaxAmount } from '@/lib/agent/handoff';
import { DEFAULT_HANDOFF, type TenantRule } from '@/lib/types';

/**
 * 规则守护 + 交接规则单测。
 *
 * 这两个模块是"约束模型"的部分：
 *   - 规则守护：对**已生成**的回复做确定性校验（提示词是引导，这里才是兜底）
 *   - 交接规则：按企业配置决定本轮是否需要人工，**不经模型**
 */

const RULES: TenantRule[] = [
  { id: 'R1', text: '客户尚未表达明确兴趣前，不主动报价', guard: 'FORBID_QUOTE_BEFORE_INTEREST' },
  { id: 'R4', text: '不得使用绝对化承诺', guard: 'FORBID_ABSOLUTE_PROMISE' },
  { id: 'R9', text: '这是一条没有校验码的普通规则' },
];

describe('checkRuleGuards — 规则守护', () => {
  it('未表达兴趣却报价 → 违规（FORBID_QUOTE_BEFORE_INTEREST）', () => {
    const violations = checkRuleGuards({
      rules: RULES,
      stage: 'DISCOVERY',
      reply: '我们现在有活动价，一节课 200 元。',
      nextAction: '报价',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].guard).toBe('FORBID_QUOTE_BEFORE_INTEREST');
    expect(violations[0].ruleId).toBe('R1');
    expect(violations[0].instruction).toContain('不要提价格');
  });

  it('已到有意向阶段 → 允许报价，不违规', () => {
    const violations = checkRuleGuards({
      rules: RULES,
      stage: 'INTERESTED',
      reply: '我们现在有活动价，一节课 200 元。',
      nextAction: '报价',
    });

    expect(violations).toHaveLength(0);
  });

  it('绝对化承诺 → 违规（FORBID_ABSOLUTE_PROMISE）', () => {
    const violations = checkRuleGuards({
      rules: RULES,
      stage: 'INTERESTED',
      reply: '放心，保证孩子能学会游泳。',
      nextAction: '回答问题',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].guard).toBe('FORBID_ABSOLUTE_PROMISE');
  });

  it('没有校验码的规则不参与机器校验', () => {
    const violations = checkRuleGuards({
      rules: [{ id: 'R9', text: '普通规则' }],
      stage: 'NEW',
      reply: '现在报名 1000 元，保证学会',
      nextAction: '报价',
    });

    expect(violations).toHaveLength(0);
  });

  it('同时违反多条规则时会全部报出', () => {
    const violations = checkRuleGuards({
      rules: RULES,
      stage: 'NEW',
      reply: '只要 199 元，保证一定有效！',
      nextAction: '报价',
    });

    expect(violations.length).toBe(2);
    expect(violations.map((v) => v.guard).sort()).toEqual([
      'FORBID_ABSOLUTE_PROMISE',
      'FORBID_QUOTE_BEFORE_INTEREST',
    ]);
  });

  it('合规回复不产生任何违规', () => {
    const violations = checkRuleGuards({
      rules: RULES,
      stage: 'DISCOVERY',
      reply: '孩子平时喜欢玩水吗？我可以先帮您安排一节适应课。',
      nextAction: '继续探需',
    });

    expect(violations).toHaveLength(0);
  });
});

describe('extractMaxAmount — 金额提取', () => {
  it('识别「元」与「万」', () => {
    expect(extractMaxAmount(['年卡 6800 元能便宜点吗？'])).toBe(6800);
    expect(extractMaxAmount(['预算大概 3 万左右'])).toBe(30000);
  });

  it('多条消息取最大值', () => {
    expect(extractMaxAmount(['先看看 800 元那档', '不过 1500 元的也行'])).toBe(1500);
  });

  it('没有金额时返回 null', () => {
    expect(extractMaxAmount(['你们周末有课吗？'])).toBeNull();
  });
});

describe('applyHandoffPolicy — 交接规则执行', () => {
  const guardViolation = {
    guard: 'FORBID_QUOTE_BEFORE_INTEREST' as const,
    ruleId: 'R1',
    message: '未表达兴趣却报价',
    instruction: '不要报价',
  };

  it('金额达到企业阈值 → 升级人工（乐蒙阈值 5000）', () => {
    const outcome = applyHandoffPolicy({
      config: { ...DEFAULT_HANDOFF, amountThreshold: 5000 },
      customerMessages: ['年卡 6800 元能便宜点吗？'],
      aiNeedHuman: false,
      aiHumanReason: null,
      aiNextAction: '报价',
      guardViolations: [],
    });

    expect(outcome.needHuman).toBe(true);
    expect(outcome.notes.join(' ')).toContain('阈值');
    expect(outcome.adjustments[0].rule).toBe('HANDOFF_POLICY_ESCALATION');
  });

  it('金额未达阈值 → 维持 AI 的判断', () => {
    const outcome = applyHandoffPolicy({
      config: { ...DEFAULT_HANDOFF, amountThreshold: 5000 },
      customerMessages: ['800 元那档怎么样'],
      aiNeedHuman: false,
      aiHumanReason: null,
      aiNextAction: '报价',
      guardViolations: [],
    });

    expect(outcome.needHuman).toBe(false);
    expect(outcome.notes).toHaveLength(0);
  });

  it('同一金额在阈值更低的企业会升级（乐蒙 5000 不转、机械之家 1000 转）', () => {
    const input = {
      customerMessages: ['保费大概 1500 元够吗？'],
      aiNeedHuman: false,
      aiHumanReason: null,
      aiNextAction: '回答问题' as const,
      guardViolations: [],
    };

    expect(applyHandoffPolicy({ ...input, config: { ...DEFAULT_HANDOFF, amountThreshold: 1000 } }).needHuman).toBe(true);
    expect(applyHandoffPolicy({ ...input, config: { ...DEFAULT_HANDOFF, amountThreshold: 5000 } }).needHuman).toBe(false);
  });

  it('命中企业敏感词 → 升级人工', () => {
    const outcome = applyHandoffPolicy({
      config: { ...DEFAULT_HANDOFF, keywords: ['退费', '起诉'] },
      customerMessages: ['这个课我不上了，我要退费！'],
      aiNeedHuman: false,
      aiHumanReason: null,
      aiNextAction: '处理异议',
      guardViolations: [],
    });

    expect(outcome.needHuman).toBe(true);
    expect(outcome.notes.join(' ')).toContain('退费');
  });

  it('规则守护违规 → 强制升级人工', () => {
    const outcome = applyHandoffPolicy({
      config: DEFAULT_HANDOFF,
      customerMessages: ['多少钱'],
      aiNeedHuman: false,
      aiHumanReason: null,
      aiNextAction: '报价',
      guardViolations: [guardViolation],
    });

    expect(outcome.needHuman).toBe(true);
    expect(outcome.humanReason).toBe('触发租户规则红线');
  });

  it('企业关闭某类触发时，AI 的建议可以被降级（并替换动作）', () => {
    const outcome = applyHandoffPolicy({
      config: { ...DEFAULT_HANDOFF, triggers: { ...DEFAULT_HANDOFF.triggers, complaint: false } },
      customerMessages: ['教练态度很差'],
      aiNeedHuman: true,
      aiHumanReason: '客户投诉',
      aiNextAction: '转人工',
      guardViolations: [],
    });

    expect(outcome.needHuman).toBe(false);
    expect(outcome.nextAction).toBe('处理异议');
    expect(outcome.adjustments[0].rule).toBe('HANDOFF_POLICY_DISABLED');
  });

  it('企业配置不能关闭系统兜底：AI 异常降级永远转人工', () => {
    const outcome = applyHandoffPolicy({
      config: {
        ...DEFAULT_HANDOFF,
        triggers: { complaint: false, wantsHuman: false, aiUnsure: false, highValue: false, ruleConflict: false },
      },
      customerMessages: [],
      aiNeedHuman: true,
      aiHumanReason: 'AI 输出异常降级',
      aiNextAction: '转人工',
      guardViolations: [],
    });

    expect(outcome.needHuman).toBe(true);
  });

  it('即使企业关闭了「投诉转人工」，命中敏感词仍会升级（企业红线优先）', () => {
    const outcome = applyHandoffPolicy({
      config: {
        ...DEFAULT_HANDOFF,
        triggers: { ...DEFAULT_HANDOFF.triggers, complaint: false },
        keywords: ['退费'],
      },
      customerMessages: ['我要退费，还要投诉'],
      aiNeedHuman: true,
      aiHumanReason: '客户投诉',
      aiNextAction: '转人工',
      guardViolations: [],
    });

    expect(outcome.needHuman).toBe(true);
  });
});
