import type { CustomerIntent, NextAction, HandoffConfig } from '@/lib/types';
import type { StateAdjustment } from './state';
import type { GuardViolation } from './guards';

/**
 * 交接规则（handoff）的**运行时执行**。
 *
 * 与 prompt 的分工：prompt 负责"告诉模型本企业的转人工标准"（引导），
 * 本文件负责"按企业配置确定性地决定这一轮是否需要人工"（约束）。
 * 只有后者才有牙齿 —— 模型可能忽略提示词，但代码不会。
 *
 * 两条关键设计（答辩要点）：
 *
 * 1) **规则守护违规与敏感词必定升级**：这是企业自己划的红线，不经模型判断，直接置为需人工。
 *    金额阈值同理（高客单行业"保费 3000 元"必须人工核保，快消行业则不必）。
 *
 * 2) **企业配置可以关闭某一类转人工，但 AI 不能自行解除**。
 *    两者的区别在于"谁在解除"：前者是人写下来、可审计、可回滚的企业规则；
 *    后者是模型在某一轮对话里的临场判断。所以：
 *      - 企业配置关掉"投诉必转人工" → 本轮建议可以不转人工（并记录一条修正说明）；
 *      - 与此同时 CustomerState.needHuman 仍然是"只升不降"，历史标记只有人工能解除。
 *    这样"每一轮的建议"与"客户当前状态"各归其位，既不失控也不僵硬。
 *
 * 3) **系统兜底不可关闭**：AI 调用异常导致的降级（human_reason = AI 输出异常降级）
 *    永远转人工，任何企业配置都不能把它关掉 —— 否则 AI 挂了还没人管。
 *
 * 4) **模型不能自相矛盾**（线上真实踩到的坑，见 `escalateOnSelfContradiction`）：
 *    有一次生产调用返回了 `customer_intent=投诉`、`next_action=转人工`，但 `need_human=false` ——
 *    模型自己分类成了投诉、自己也建议转人工，唯独那个布尔值说不用。
 *    而当时的实现**只信那个布尔值**，于是"我要投诉"没有转人工。
 *    教训：不要只信模型的一个字段。它的多个结构化输出之间可以交叉验证，
 *    一旦互相矛盾，就采纳**更保护客户**的那一侧（并记录成可展示的修正）。
 */

const REASON_TO_TRIGGER: Record<string, keyof HandoffConfig['triggers'] | 'ALWAYS'> = {
  客户投诉: 'complaint',
  客户明确要求真人: 'wantsHuman',
  'AI 无法确认答案': 'aiUnsure',
  高价值成交信号: 'highValue',
  触发租户规则红线: 'ruleConflict',
  'AI 输出异常降级': 'ALWAYS',
  其他: 'ALWAYS',
};

/**
 * 与租户无关的**通用投诉/维权信号词**。
 *
 * 定位：企业自配的 `keywords` 是"这家企业特别在意的词"，本表是"任何企业都不该漏掉的底线"
 * （企业可能漏配「投诉」，但没人会认为投诉可以不用人管）。
 * 是否升级仍由 `triggers.complaint` 决定 —— 保留企业显式关闭的能力，只是不允许"忘记配置"。
 */
const UNIVERSAL_RISK_WORDS = [
  '投诉',
  '举报',
  '12315',
  '消协',
  '工商局',
  '曝光',
  '起诉',
  '律师',
  '差评',
  '退款',
  '退费',
  '退钱',
  '骗人',
  '骗子',
];

/** 因企业配置关闭转人工时，把"转人工"这个动作替换成合理的替代动作 */
const DOWNGRADE_ACTION: Record<string, NextAction> = {
  客户投诉: '处理异议',
  客户明确要求真人: '回答问题',
  'AI 无法确认答案': '回答问题',
  高价值成交信号: '确认需求',
  触发租户规则红线: '回答问题',
};

export type HandoffOutcome = {
  needHuman: boolean;
  humanReason: string | null;
  nextAction: NextAction;
  /** 触发/解除说明，写入日志便于排障 */
  notes: string[];
  adjustments: StateAdjustment[];
};

export function applyHandoffPolicy(params: {
  config: HandoffConfig;
  /** 本轮客户消息文本（用于敏感词与金额检测） */
  customerMessages: string[];
  /** AI 对本轮客户意图的**分类结果**（有界枚举，用于交叉验证） */
  aiCustomerIntent: CustomerIntent;
  aiNeedHuman: boolean;
  aiHumanReason: string | null;
  aiNextAction: NextAction;
  guardViolations: GuardViolation[];
}): HandoffOutcome {
  const { config } = params;
  const notes: string[] = [];
  const adjustments: StateAdjustment[] = [];

  let needHuman = params.aiNeedHuman;
  let humanReason = params.aiHumanReason;
  let nextAction = params.aiNextAction;
  /** 是否已被"企业配置关闭某类触发"这条路径降级过 —— 降级后不再做自洽性修复 */
  let downgradedByPolicy = false;

  // ---- 1) 规则守护违规：企业红线，直接升级 --------------------------------
  if (params.guardViolations.length > 0 && config.triggers.ruleConflict) {
    needHuman = true;
    humanReason = '触发租户规则红线';
    notes.push(
      `规则守护发现 ${params.guardViolations.length} 处违规：${params.guardViolations
        .map((v) => `${v.ruleId} ${v.message}`)
        .join('；')}`,
    );
  }

  // ---- 2) 敏感词：命中即升级 ----------------------------------------------
  const hitKeyword = config.keywords.find((keyword) =>
    params.customerMessages.some((message) => message.includes(keyword)),
  );
  if (hitKeyword) {
    needHuman = true;
    humanReason = '触发租户规则红线';
    notes.push(`客户消息命中企业敏感词「${hitKeyword}」，按交接规则转人工`);
  }

  // ---- 3) 金额阈值 --------------------------------------------------------
  if (config.amountThreshold !== null) {
    const amount = extractMaxAmount(params.customerMessages);
    if (amount !== null && amount >= config.amountThreshold) {
      needHuman = true;
      humanReason = humanReason ?? '高价值成交信号';
      notes.push(`对话涉及金额约 ${amount} 元，达到企业阈值 ${config.amountThreshold} 元，按交接规则转人工`);
    }
  }

  // ---- 3.5) 通用投诉场景：确定性识别，不依赖模型的 need_human ----------------
  // 企业自配词表可能漏配（例如只配了"投诉到总部"而客户说的是"我要投诉"），
  // 而"投诉必须有人接"是普适底线，所以这里再兜一层通用词。
  const riskWord = UNIVERSAL_RISK_WORDS.find((word) =>
    params.customerMessages.some((message) => message.includes(word)),
  );
  if (riskWord && config.triggers.complaint && !needHuman) {
    needHuman = true;
    humanReason = '客户投诉';
    notes.push(`客户消息命中通用维权信号「${riskWord}」，按投诉场景转人工（与企业敏感词表叠加的底线保护）`);
  }

  // ---- 4) 企业配置关闭某一类转人工（唯一能"降级"的路径，且必须记录） ------
  if (params.aiNeedHuman && params.aiHumanReason) {
    const triggerKey = REASON_TO_TRIGGER[params.aiHumanReason];
    const enabled = triggerKey === 'ALWAYS' || triggerKey === undefined ? true : config.triggers[triggerKey];

    if (!enabled) {
      // 注意：只有在"没有其它升级理由"时才真正降级
      const escalatedByPolicy =
        Boolean(hitKeyword) || params.guardViolations.length > 0 || Boolean(riskWord);
      if (!escalatedByPolicy) {
        needHuman = false;
        humanReason = null;
        downgradedByPolicy = true;

        const replacement = DOWNGRADE_ACTION[params.aiHumanReason];
        if (replacement && nextAction === '转人工') {
          nextAction = replacement;
        }

        adjustments.push({
          field: 'need_human',
          suggested: 'true',
          adopted: 'false',
          rule: 'HANDOFF_POLICY_DISABLED',
          note: `AI 建议因「${params.aiHumanReason}」转人工，但本企业交接规则未启用该情形，故本轮不升级${
            replacement && params.aiNextAction === '转人工' ? `（动作改为「${replacement}」）` : ''
          }`,
        });
        notes.push(`企业交接规则未启用「${params.aiHumanReason}」，本轮建议不转人工`);
      }
    }
  }

  // ---- 5) 最终升级：记录成可展示的修正 ------------------------------------
  if (needHuman && !params.aiNeedHuman) {
    adjustments.push({
      field: 'need_human',
      suggested: 'false',
      adopted: 'true',
      rule: 'HANDOFF_POLICY_ESCALATION',
      note: `按企业交接规则升级为人工介入：${notes.at(-1) ?? humanReason ?? '达到转人工条件'}`,
    });
  }

  /*
   * ---- 6) 自洽性兜底：模型不能自相矛盾 ------------------------------------
   *
   * 这是线上真实踩到的坑：一次生产调用返回
   *   customer_intent = 投诉 、 next_action = 转人工 、 need_human = false
   * —— 模型既把客户分类成投诉，又自己建议转人工，唯独那个布尔值说不用。
   * 当时的实现只信 need_human，于是「我要投诉」没有转人工（冒烟断言在线上当场报红）。
   *
   * 为什么放在最后：企业显式关闭某类触发时，上一步会把 need_human 与 next_action
   * **一起**改写（不再自相矛盾），那种情况不该被这里再翻回来。
   * 只有当输出"仍然自相矛盾"时，才采纳更保护客户的一侧 —— 并且留痕，让人看得见。
   */
  if (!needHuman && !downgradedByPolicy) {
    const aiWantsHuman =
      params.aiCustomerIntent === '投诉' ||
      params.aiHumanReason !== null ||
      params.aiNextAction === '转人工' ||
      Boolean(riskWord);

    /*
     * 矛盾被归到哪一类，决定要不要尊重企业的关闭开关：
     *   - 投诉类信号（意图=投诉 / 通用维权词 / 理由=客户投诉）→ 归 complaint
     *   - 理由能映射到某个企业可配置的类别 → 归该类别
     *   - 剩下的（模型只说"该转人工"、或系统降级）→ 属**输出自洽性**，不是企业可关闭的类别
     */
    const complaintSignal =
      params.aiCustomerIntent === '投诉' || Boolean(riskWord) || params.aiHumanReason === '客户投诉';
    const mapped = params.aiHumanReason ? REASON_TO_TRIGGER[params.aiHumanReason] : undefined;
    const category = complaintSignal
      ? ('complaint' as const)
      : mapped && mapped !== 'ALWAYS'
        ? mapped
        : null;
    const categoryDisabled = category !== null && !config.triggers[category];

    const evidence =
      params.aiCustomerIntent === '投诉'
        ? 'AI 把客户意图判定为「投诉」'
        : params.aiHumanReason !== null
          ? `AI 给出了转人工理由「${params.aiHumanReason}」`
          : params.aiNextAction === '转人工'
            ? 'AI 建议的下一步动作是「转人工」'
            : `客户消息命中通用维权信号「${riskWord}」`;

    if (aiWantsHuman && categoryDisabled) {
      /*
       * 企业**显式关闭**了这一类转人工 → 尊重企业配置，但必须把输出改写成自洽的：
       * 不能出现"状态说不需要人、动作却写着转人工"这种自相矛盾的界面。
       */
      const replacement = DOWNGRADE_ACTION[params.aiHumanReason ?? ''] ?? '回答问题';
      if (nextAction === '转人工') nextAction = replacement;
      notes.push(`企业交接规则未启用「${category === 'complaint' ? '投诉转人工' : category}」，本轮不升级（动作改为「${replacement}」）`);
      adjustments.push({
        field: 'need_human',
        suggested: 'true',
        adopted: 'false',
        rule: 'HANDOFF_POLICY_DISABLED',
        note: `${evidence}，但本企业未启用该类转人工，故本轮不升级`,
      });
    } else if (aiWantsHuman) {
      needHuman = true;
      humanReason = params.aiHumanReason ?? (complaintSignal ? '客户投诉' : '其他');
      if (nextAction !== '转人工') nextAction = '转人工';
      notes.push(`${evidence}，但 need_human=false —— 输出自相矛盾，系统采纳更保护客户的一侧（转人工）`);

      adjustments.push({
        field: 'need_human',
        suggested: 'false',
        adopted: 'true',
        rule: 'HANDOFF_SELF_CONTRADICTION',
        note: `${evidence}，但 AI 同时判断无需人工 —— 两者矛盾时系统按更保护客户的一侧处理`,
      });
    }
  }

  return { needHuman, humanReason: needHuman ? (humanReason ?? '其他') : null, nextAction, notes, adjustments };
}

/** 从客户消息中提取最大金额（支持"3 万""5000 元""1500 块"） */
export function extractMaxAmount(messages: string[]): number | null {
  let max: number | null = null;
  const pattern = /(\d+(?:\.\d+)?)\s*(万|元|块)/g;

  for (const message of messages) {
    for (const match of message.matchAll(pattern)) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) continue;
      const amount = match[2] === '万' ? value * 10_000 : value;
      if (max === null || amount > max) max = amount;
    }
  }

  return max;
}
