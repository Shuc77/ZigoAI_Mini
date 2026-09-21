/**
 * "这一批该等多久" —— 把固定窗口换成**对"客户说完了没有"的估计**。
 *
 * 为什么需要它（真实的使用反馈）：
 *   原实现里窗口是一个常量（8 秒）。客户连发 3 条之后，销售就盯着
 *   "约 8 秒后统一判断"干等 —— 明明客户最后一句是个问句、显然在等答案，
 *   系统却还在等一个写死的 8 秒。**拖的不是模型，是我们自己加的等待**
 *   （实测 deepseek-flash 一次完整判断只要 100–350ms）。
 *
 * 关键认识：**"响应感"和"判断完整度"是两件事**。
 *   把窗口一刀切成 0 → 客户连发 5 条就回 5 次，机器人感全回来了，而且后面几次是基于残缺上下文；
 *   真正要的是"**说完就收口**"：客户还在打字就等，客户说完了就走。
 *
 * 三档窗口（判据全部来自我们已有的信息，不需要微信的"正在输入"状态）：
 *   - QUESTION  最后一句是问句 / 明确诉求（多少钱、能不能、什么时候…）→ 客户在等答案，最短
 *   - FOLLOW_UP 已连发 ≥2 条 → 客户在补充说明，比单条陈述更接近说完，但仍留一点合并余地
 *   - STATEMENT 单条陈述 → 保持原来的窗口，宁可多等也别抢答
 *
 * 设 `MESSAGE_BATCH_FAST_WINDOW_MS` = `MESSAGE_BATCH_WINDOW_MS` 即可退回"固定窗口"的老行为。
 */

/** 三档窗口的判定原因（会回传给界面，让"为什么现在才判断"看得见） */
export type BatchWindowReason = 'QUESTION' | 'FOLLOW_UP' | 'STATEMENT';

/**
 * "客户在等一个答案"的信号词。
 * 只做**保守**匹配：宁可漏判（退回长窗口），也不要把陈述句误判成问句而提前抢答。
 */
const INTENT_PATTERNS: readonly RegExp[] = [
  /多少(钱|费用)?/,
  /(价格|价钱|价位|收费|费用|报价)/,
  /怎么(办|样|卖|收费|报名|算)/,
  /能不能|可不可以|可以吗|行不行|有没有/,
  /什么时候|多久|几天|多长时间|在哪|地址/,
  /我要|我想|想(了解|报名|买|要|问)/,
  /有(人|货|位|名额|课|空|时间)吗/,
  /在(吗|么|不在)/,
  /贵(吗|不贵)/,
];

/**
 * 结尾的疑问语气：问号，或"吗/呢/么"这类疑问助词。
 * 中文里"你们周末有课吗"常常不带问号，所以不能只看标点。
 */
const QUESTION_TAIL = /[?？吗呢么]$/;

/** 结尾是问号 / 疑问助词，或命中明确诉求词 → 客户在等一个答案 */
export function looksLikeQuestion(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (QUESTION_TAIL.test(text)) return true;
  return INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export const DEFAULT_BATCH_WINDOW_MS = 8_000;
export const DEFAULT_BATCH_FAST_WINDOW_MS = 2_000;

/** 连发补充时的窗口 = 快速窗口 × 该系数（2s → 3s） */
export const FOLLOW_UP_WINDOW_RATIO = 1.5;

export function resolveBatchWindow(params: {
  /** 该批次最后一条客户消息的内容 */
  lastContent: string;
  /** 该批次当前有多少条客户消息（含刚入库的这条） */
  messageCount: number;
  /** 单条陈述的窗口（默认取环境变量 MESSAGE_BATCH_WINDOW_MS） */
  baseWindowMs?: number;
  /** "客户在等答案"的窗口（默认取环境变量 MESSAGE_BATCH_FAST_WINDOW_MS） */
  fastWindowMs?: number;
}): { windowMs: number; reason: BatchWindowReason } {
  const base = params.baseWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  // fast 不允许超过 base：这样"把两者设成一样"就精确等价于旧的固定窗口行为
  const fast = Math.min(params.fastWindowMs ?? DEFAULT_BATCH_FAST_WINDOW_MS, base);

  if (looksLikeQuestion(params.lastContent)) {
    return { windowMs: fast, reason: 'QUESTION' };
  }

  if (params.messageCount >= 2) {
    return { windowMs: Math.min(Math.round(fast * FOLLOW_UP_WINDOW_RATIO), base), reason: 'FOLLOW_UP' };
  }

  return { windowMs: base, reason: 'STATEMENT' };
}

/** 给界面用的一句话解释（用户看到的必须和实际行为一致） */
export function describeBatchWindow(reason: BatchWindowReason): string {
  switch (reason) {
    case 'QUESTION':
      return '客户这句在等答复';
    case 'FOLLOW_UP':
      return '客户正在补充说明';
    default:
      return '客户这句像是陈述';
  }
}
