/**
 * 环境变量的唯一入口。
 * 设计意图：把"读环境变量"这件事收敛到一处，缺关键变量时**启动即失败**，
 * 而不是等到某次 AI 调用才报 undefined —— 这是 24H 项目里最省时间的一个习惯。
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}。本地开发见 .env.example，服务器见 /opt/zigoai/.env（两者都不入库）。`,
    );
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),

  deepseekApiKey: required('DEEPSEEK_API_KEY'),
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  /** 默认模型：实测 deepseek-flash + json_object 约 1.3s，性价比最适合本场景 */
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  /** 更强的模型，用于销售手动"深度重判" */
  deepseekModelPro: process.env.DEEPSEEK_MODEL_PRO ?? 'deepseek-v4-pro',
  deepseekTimeoutMs: num('DEEPSEEK_TIMEOUT_MS', 20_000),

  /** 成本统计单价（元 / 百万 token），Step 0 按官方价目表核对 */
  priceInPerMTok: num('DEEPSEEK_PRICE_IN_PER_MTOK', 0),
  priceOutPerMTok: num('DEEPSEEK_PRICE_OUT_PER_MTOK', 0),

  sessionSecret: required('SESSION_SECRET'),

  /** 连续消息聚合窗口：窗口内的多条客户消息算"一轮沟通"，只调一次 AI */
  batchWindowMs: num('MESSAGE_BATCH_WINDOW_MS', 8_000),
  /** 客户静默超过该分钟数即视为需要跟进 */
  followUpIdleMinutes: num('FOLLOWUP_IDLE_MINUTES', 2),
  /** 最大跟进次数，防止无限打扰客户 */
  followUpMaxAttempts: num('FOLLOWUP_MAX_ATTEMPTS', 2),
} as const;

/** 按 token 用量估算人民币成本（用于 AiSuggestion.estimatedCostCny 与 AI 日志页） */
export function estimateCostCny(promptTokens = 0, completionTokens = 0): number {
  return (
    (promptTokens / 1_000_000) * env.priceInPerMTok +
    (completionTokens / 1_000_000) * env.priceOutPerMTok
  );
}
