import type { LeadStage } from '@/generated/prisma/enums';
import { NEXT_ACTIONS, type TenantRule } from '@/lib/types';

/**
 * 规则守护（Rule Guards）—— **对 AI 生成的回复做确定性校验**。
 *
 * 为什么需要它：prompt 里的规则只是"引导"，模型可能不遵守（尤其在长上下文、客户话术诱导下）。
 * 企业规则里真正不能碰的红线，必须由代码兜底，而不是指望模型自觉。
 *
 * 工作方式（写在 pipeline 里）：
 *   生成回复 → 跑守护检查 → 违规则把"违规原因"回灌给模型重写一次 → 仍违规则：
 *   标记 ruleViolation + 强制转人工，绝不把违规内容当成正常建议推给销售。
 */

export type GuardViolation = {
  guard: NonNullable<TenantRule['guard']>;
  ruleId: string;
  message: string;
  /** 回灌给模型的重写要求 */
  instruction: string;
};

/** 报价/价格相关表达（用于"未表达兴趣前不得报价"的检测） */
const PRICE_PATTERN = /(报价|价格|多少钱|费用|收费|单价|总价|折扣|优惠|活动价|免费|元|块钱|块左右|万)/;

/** 绝对化承诺表达（教育、保险等行业都不能做绝对承诺） */
const ABSOLUTE_PROMISE_PATTERN = /(保证|一定能|肯定能|百分百|100%|绝对|承诺|包过|包会|必定)/;

export function checkRuleGuards(params: {
  rules: TenantRule[];
  /** **采纳后**的阶段：判断"当时该不该报价"要用系统认可的事实 */
  stage: LeadStage;
  reply: string;
  nextAction: string;
}): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const rule of params.rules) {
    if (!rule.guard) continue;

    if (rule.guard === 'FORBID_QUOTE_BEFORE_INTEREST') {
      // 阶段尚未到"有意向"，说明客户还没表达兴趣 → 回复中不应出现报价
      const beforeInterest = params.stage === 'NEW' || params.stage === 'DISCOVERY';
      const hit = params.reply.match(PRICE_PATTERN);
      if (beforeInterest && hit) {
        violations.push({
          guard: rule.guard,
          ruleId: rule.id,
          message: `客户尚处于「${params.stage}」阶段，回复中却出现了报价相关表达「${hit[0]}」`,
          instruction:
            '客户还没有表达明确兴趣，不要提价格、费用、优惠或金额。请改为先了解需求或推动体验，并把话说得具体、自然。',
        });
      }
    }

    if (rule.guard === 'FORBID_ABSOLUTE_PROMISE') {
      const hit = params.reply.match(ABSOLUTE_PROMISE_PATTERN);
      if (hit) {
        violations.push({
          guard: rule.guard,
          ruleId: rule.id,
          message: `回复中出现了绝对化承诺表达「${hit[0]}」`,
          instruction:
            '不要使用"保证/一定/100%/绝对/承诺"这类绝对化表达，改为客观描述服务内容与条件，必要时说明需人工确认。',
        });
      }
    }

    if (rule.guard === 'REQUIRE_DOC_REQUEST_ON_DEVICE_INTENT') {
      // 客户已确认设备/保险需求且到了有意向阶段，却整段没提资料 → 说明没执行企业的关键动作
      const shouldAskDoc = params.stage === 'INTERESTED' || params.stage === 'HIGH_INTENT';
      const askedDoc = /(行驶证|证件|资料|照片|保单|车架号)/.test(params.reply);
      const isAnsweringNotAsking = params.nextAction === '回答问题' || params.nextAction === '报价';
      if (shouldAskDoc && !askedDoc && !isAnsweringNotAsking) {
        violations.push({
          guard: rule.guard,
          ruleId: rule.id,
          message: '客户已有明确设备与保险需求，但回复中未按企业规则索取行驶证等资料',
          instruction:
            '按企业规则，客户已确认设备与保险需求，请在回复中自然地索取行驶证照片（说明用途：用于按吨位与车龄出方案）。',
        });
      }
    }
  }

  return violations;
}

/** 供 prompt 使用：告诉模型"允许的动作白名单"，避免它自由发挥出不在枚举里的动作 */
export const ALLOWED_NEXT_ACTIONS = NEXT_ACTIONS;
