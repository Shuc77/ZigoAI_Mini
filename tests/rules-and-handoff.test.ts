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

  /** 测试默认参数：AI 认为客户在询价、不需要人工 */
  const base = {
    aiCustomerIntent: '询价' as const,
    aiNeedHuman: false,
    aiHumanReason: null,
    aiNextAction: '报价' as const,
    guardViolations: [],
  };

  it('金额达到企业阈值 → 升级人工（乐蒙阈值 5000）', () => {
    const outcome = applyHandoffPolicy({
      ...base,
      config: { ...DEFAULT_HANDOFF, amountThreshold: 5000 },
      customerMessages: ['年卡 6800 元能便宜点吗？'],
    });

    expect(outcome.needHuman).toBe(true);
    expect(outcome.notes.join(' ')).toContain('阈值');
    expect(outcome.adjustments[0].rule).toBe('HANDOFF_POLICY_ESCALATION');
  });

  it('金额未达阈值 → 维持 AI 的判断', () => {
    const outcome = applyHandoffPolicy({
      ...base,
      config: { ...DEFAULT_HANDOFF, amountThreshold: 5000 },
      customerMessages: ['800 元那档怎么样'],
    });

    expect(outcome.needHuman).toBe(false);
    expect(outcome.notes).toHaveLength(0);
  });

  it('同一金额在阈值更低的企业会升级（乐蒙 5000 不转、机械之家 1000 转）', () => {
    const input = {
      ...base,
      customerMessages: ['保费大概 1500 元够吗？'],
      aiNextAction: '回答问题' as const,
    };

    expect(applyHandoffPolicy({ ...input, config: { ...DEFAULT_HANDOFF, amountThreshold: 1000 } }).needHuman).toBe(true);
    expect(applyHandoffPolicy({ ...input, config: { ...DEFAULT_HANDOFF, amountThreshold: 5000 } }).needHuman).toBe(false);
  });

  it('命中企业敏感词 → 升级人工', () => {
    const outcome = applyHandoffPolicy({
      ...base,
      config: { ...DEFAULT_HANDOFF, keywords: ['退费', '起诉'], amountThreshold: null, },
      customerMessages: ['这个课我不上了，我要退费！'],
      aiNextAction: '处理异议',
    });

    expect(outcome.needHuman).toBe(true);
    expect(outcome.notes.join(' ')).toContain('退费');
  });

  it('规则守护违规 → 强制升级人工', () => {
    const outcome = applyHandoffPolicy({
      ...base,
      config: DEFAULT_HANDOFF,
      customerMessages: ['多少钱'],
      guardViolations: [guardViolation],
    });

    expect(outcome.needHuman).toBe(true);
    expect(outcome.humanReason).toBe('触发租户规则红线');
  });

  it('企业关闭某类触发时，AI 的建议可以被降级（并替换动作）', () => {
    const outcome = applyHandoffPolicy({
      ...base,
      config: { ...DEFAULT_HANDOFF, triggers: { ...DEFAULT_HANDOFF.triggers, complaint: false } },
      customerMessages: ['教练态度很差'],
      aiCustomerIntent: '投诉',
      aiNeedHuman: true,
      aiHumanReason: '客户投诉',
      aiNextAction: '转人工',
    });

    expect(outcome.needHuman).toBe(false);
    expect(outcome.nextAction).toBe('处理异议');
    expect(outcome.adjustments[0].rule).toBe('HANDOFF_POLICY_DISABLED');
  });

  it('企业配置不能关闭系统兜底：AI 异常降级永远转人工', () => {
    const outcome = applyHandoffPolicy({
      ...base,
      config: {
        ...DEFAULT_HANDOFF,
        triggers: {
          complaint: false,
          wantsHuman: false,
          aiUnsure: false,
          highValue: false,
          ruleConflict: false,
          churnRisk: false,
          dealClosing: false,
        },
      },
      customerMessages: [],
      aiNeedHuman: true,
      aiHumanReason: 'AI 输出异常降级',
      aiNextAction: '转人工',
    });

    expect(outcome.needHuman).toBe(true);
  });

  it('即使企业关闭了「投诉转人工」，命中敏感词仍会升级（企业红线优先）', () => {
    const outcome = applyHandoffPolicy({
      ...base,
      config: {
        ...DEFAULT_HANDOFF,
        triggers: { ...DEFAULT_HANDOFF.triggers, complaint: false },
        keywords: ['退费'],
      },
      customerMessages: ['我要退费，还要投诉'],
      aiCustomerIntent: '投诉',
      aiNeedHuman: true,
      aiHumanReason: '客户投诉',
      aiNextAction: '转人工',
    });

    expect(outcome.needHuman).toBe(true);
  });

  /*
   * 以下三条守的是**线上真实踩到的坑**：
   * 生产上模型返回了 customer_intent=投诉、next_action=转人工，但 need_human=false，
   * 而当时的实现只信 need_human —— 于是「我要投诉」没有转人工（冒烟断言在线上当场报红）。
   */
  describe('自洽性兜底：模型不能自相矛盾', () => {
    it('意图=投诉 但 need_human=false → 系统按投诉转人工（生产事故复现）', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: DEFAULT_HANDOFF,
        // 用的就是线上那条消息
        customerMessages: ['我要投诉，上次教练态度很差'],
        aiCustomerIntent: '投诉',
        aiNextAction: '转人工',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(true);
      expect(outcome.humanReason).toBe('客户投诉');
      expect(outcome.nextAction).toBe('转人工');
      expect(outcome.notes.join(' ')).toContain('投诉');
    });

    it('消息里没有维权词、只有 AI 分类矛盾时，由自洽性兜底接住', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: DEFAULT_HANDOFF,
        customerMessages: ['上周约的课没人通知我，太不负责了'],
        aiCustomerIntent: '投诉',
        aiNextAction: '回答问题',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(true);
      expect(outcome.humanReason).toBe('客户投诉');
      expect(outcome.nextAction).toBe('转人工');
      expect(outcome.adjustments.at(-1)?.rule).toBe('HANDOFF_SELF_CONTRADICTION');
      expect(outcome.notes.join(' ')).toContain('自相矛盾');
    });

    it('只说「转人工」却没标 need_human → 同样按更保护客户的一侧处理', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: DEFAULT_HANDOFF,
        customerMessages: ['你们教练太不负责了'],
        aiNextAction: '转人工',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(true);
      expect(outcome.notes.join(' ')).toContain('转人工');
    });

    it('通用维权信号词兜底：企业漏配「投诉」也能兜住', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: { ...DEFAULT_HANDOFF, keywords: ['投诉到总部'], amountThreshold: null },
        customerMessages: ['我要投诉你们'],
        aiCustomerIntent: '其他',
        aiNextAction: '回答问题',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(true);
      expect(outcome.humanReason).toBe('客户投诉');
    });

    it('企业显式关闭投诉升级时，不会因为自洽性兜底被翻回来', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: { ...DEFAULT_HANDOFF, triggers: { ...DEFAULT_HANDOFF.triggers, complaint: false } },
        customerMessages: ['我要投诉你们'],
        aiCustomerIntent: '投诉',
        aiNextAction: '转人工',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(false);
      expect(outcome.nextAction).not.toBe('转人工');
    });

    it('输出自洽（询价 + 不转人工 + need_human=false）时不做任何改写', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: DEFAULT_HANDOFF,
        customerMessages: ['你们周末有课吗？'],
      });

      expect(outcome.needHuman).toBe(false);
      expect(outcome.adjustments).toHaveLength(0);
      expect(outcome.notes).toHaveLength(0);
    });
  });

  /*
   * 真实案例（客户说「都不方便，不要了」）：
   *   AI 判对了（明确拒绝、建议置为流失），状态机也拦下了它（不让 AI 写终态），
   *   但**没有人被通知** —— "终态属于人工动作"却只是一句修正说明。
   * 这一组守的就是那条闭环：AI 建议终态 → 必须升级人工，且理由是能直接指导动作的那类。
   */
  describe('AI 建议终态 → 终态是人工动作，必须有人去确认', () => {
    it('AI 建议流失 → 升级人工，理由是「客户流失倾向」（不是笼统的投诉）', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: DEFAULT_HANDOFF,
        customerMessages: ['都不方便，不要了'],
        aiCustomerIntent: '拒绝',
        aiSuggestedTerminal: 'LOST',
        aiNextAction: '暂不处理',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(true);
      expect(outcome.humanReason).toBe('客户流失倾向');
      expect(outcome.notes.join(' ')).toContain('必须由人确认');
    });

    it('AI 建议成交 → 升级人工，理由是「成交待确认」', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: DEFAULT_HANDOFF,
        customerMessages: ['那我明天过来签合同'],
        aiCustomerIntent: '购买',
        aiSuggestedTerminal: 'WON',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(true);
      expect(outcome.humanReason).toBe('成交待确认');
    });

    it('企业显式关闭「流失倾向转人工」时尊重配置（不再升级）', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: { ...DEFAULT_HANDOFF, triggers: { ...DEFAULT_HANDOFF.triggers, churnRisk: false } },
        customerMessages: ['不要了'],
        aiCustomerIntent: '拒绝',
        aiSuggestedTerminal: 'LOST',
        aiNextAction: '暂不处理',
        aiNeedHuman: false,
      });

      expect(outcome.needHuman).toBe(false);
      expect(outcome.notes).toHaveLength(0);
    });

    it('但若 AI 自己又说了「转人工」，自洽性兜底仍然升级（不受企业开关限制）', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: { ...DEFAULT_HANDOFF, triggers: { ...DEFAULT_HANDOFF.triggers, churnRisk: false } },
        customerMessages: ['不要了'],
        aiCustomerIntent: '拒绝',
        aiSuggestedTerminal: 'LOST',
        aiNextAction: '转人工',
        aiNeedHuman: false,
      });

      // 企业可以关掉"某类风险自动升级"，但关不掉"模型自己说该转人工却标了不需要人"这种自相矛盾
      expect(outcome.needHuman).toBe(true);
      expect(outcome.adjustments.at(-1)?.rule).toBe('HANDOFF_SELF_CONTRADICTION');
    });

    it('没有终态信号时完全不介入（普通对话不该被升级）', () => {
      const outcome = applyHandoffPolicy({
        ...base,
        config: DEFAULT_HANDOFF,
        customerMessages: ['你们周末有课吗？'],
        aiSuggestedTerminal: null,
      });

      expect(outcome.needHuman).toBe(false);
      expect(outcome.notes).toHaveLength(0);
    });
  });
});
