import { env } from '@/lib/env';

/**
 * DeepSeek 客户端（原生 fetch，不引 SDK）。
 *
 * 三条设计约束（都是踩过的坑换来的）：
 * 1) **绝不抛异常**：返回结果对象而不是 throw。AI 调用失败是"一等业务状态"，
 *    上游需要据此降级（转人工 / 告警），而不是让整个请求崩掉。
 * 2) **原始请求与响应完整带出**：写入 AiSuggestion.rawRequest/rawResponse，
 *    让每次 AI 判断都可回放、可定位线上问题。
 * 3) **区分失败类型**：超时 / HTTP 错误 / 网络错误 / 空内容 / 结构异常，
 *    因为 DeepSeek 官方明确提示 JSON 模式偶发返回空内容，这必须能被单独识别并重试。
 */

export type LlmErrorKind =
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'empty_content'
  | 'truncated'
  | 'bad_response'
  | 'bad_request';

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  /** deepseek-flash 会先花 token 做推理，这部分会计入 completion_tokens */
  reasoningTokens: number;
};

export type LlmResult = {
  ok: boolean;
  content: string | null;
  model: string;
  /** **模型真实耗时**：响应体读完之后才算（首字节到达时间见 ttfbMs） */
  latencyMs: number;
  /** 首字节时间（TTFB）—— 与 latencyMs 的差值就是模型"生成"的时间 */
  ttfbMs?: number;
  usage: LlmUsage;
  rawRequest: unknown;
  rawResponse: unknown;
  finishReason?: string;
  errorKind?: LlmErrorKind;
  errorMessage?: string;
};

export type LlmJsonRequest = {
  system: string;
  user: string;
  /** 覆盖默认模型（例如销售点击"深度重判"时用 deepseek-v4-pro） */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** 打印日志用，便于在服务器日志里定位是哪一次判断 */
  label?: string;
};

const EMPTY_USAGE: LlmUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedPromptTokens: 0,
  reasoningTokens: 0,
};

export async function callDeepSeekJson(request: LlmJsonRequest): Promise<LlmResult> {
  const model = request.model ?? env.deepseekModel;
  const startedAt = Date.now();

  const body = {
    model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    // DeepSeek 官方要求：JSON 模式需 response_format + 提示词中出现 "json" 字样 + 合理 max_tokens
    response_format: { type: 'json_object' },
    max_tokens: request.maxTokens ?? 1024,
    temperature: request.temperature ?? 0.3,
    stream: false,
  };

  const rawRequest = {
    url: `${env.deepseekBaseUrl}/chat/completions`,
    model,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    responseFormat: body.response_format.type,
    // 出于安全与体积考虑，审计里保留完整 messages（不含密钥）
    messages: body.messages,
  };

  let response: Response;
  try {
    response = await fetch(`${env.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.deepseekApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.deepseekTimeoutMs),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const latencyMs = Date.now() - startedAt;
    const errorKind: LlmErrorKind = isTimeout ? 'timeout' : 'network_error';
    console.error(`[llm] ${request.label ?? 'call'} 失败(${errorKind}) 耗时 ${latencyMs}ms`);
    return {
      ok: false,
      content: null,
      model,
      latencyMs,
      usage: EMPTY_USAGE,
      rawRequest,
      rawResponse: null,
      errorKind,
      errorMessage: isTimeout
        ? `调用超时（>${env.deepseekTimeoutMs}ms）`
        : `网络错误：${(error as Error).message}`,
    };
  }

  /*
   * 计时点必须放在**响应体读完之后**（这是踩过的坑，也是审计数据可信度的关键）。
   *
   * `fetch()` 在"响应头到达"时就 resolve 了，响应体是之后流式到达的。
   * 早期实现把计时点放在 fetch 之后，于是 `AiSuggestion.latencyMs` 记录的是 **TTFB（首字节时间）**，
   * 而不是模型真正花的时间：实测同一个请求 首字节 220ms / 完整响应 2600ms —— **低估了 10 倍**。
   * 后果很实际：排查"客户抱怨要等很久"时，日志会指向一个"模型只要 200ms"的假象，
   * 让人去怀疑窗口、网络、数据库，而真正的大头被埋掉了。
   */
  const ttfbMs = Date.now() - startedAt;

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    console.error(`[llm] ${request.label ?? 'call'} 读取响应体失败 耗时 ${elapsed}ms`);
    return {
      ok: false,
      content: null,
      model,
      latencyMs: elapsed,
      usage: EMPTY_USAGE,
      rawRequest,
      rawResponse: null,
      errorKind: 'network_error',
      errorMessage: `读取响应体失败：${(error as Error).message}`,
    };
  }

  /** 模型真实耗时：首字节 + 生成完整响应体的时间 */
  const fullLatencyMs = Date.now() - startedAt;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`[llm] ${request.label ?? 'call'} 返回非 JSON（HTTP ${response.status}）`);
    return {
      ok: false,
      content: null,
      model,
      latencyMs: fullLatencyMs,
      ttfbMs,
      usage: EMPTY_USAGE,
      rawRequest,
      rawResponse: text.slice(0, 2000),
      errorKind: 'bad_response',
      errorMessage: `响应不是合法 JSON（HTTP ${response.status}）`,
    };
  }

  const payload = parsed as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
    error?: { message?: string; type?: string };
  };

  const usage: LlmUsage = {
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
    cachedPromptTokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
    reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };

  const finishReason = payload.choices?.[0]?.finish_reason;

  if (!response.ok) {
    const message = payload.error?.message ?? `HTTP ${response.status}`;
    console.error(`[llm] ${request.label ?? 'call'} HTTP ${response.status}: ${message}`);
    return {
      ok: false,
      content: null,
      model,
      latencyMs: fullLatencyMs,
      ttfbMs,
      usage,
      rawRequest,
      rawResponse: payload,
      errorKind: 'http_error',
      errorMessage: message,
    };
  }

  const content = payload.choices?.[0]?.message?.content ?? null;

  // 预算不足（finish_reason=length）：deepseek-flash 会先花 token 做推理，
  // max_tokens 过小时 JSON 会被截断甚至整段为空。
  // 必须与"偶发空内容"区分开：前者要加大预算重试，后者原参数重试即可。
  if (finishReason === 'length') {
    console.warn(
      `[llm] ${request.label ?? 'call'} 输出被截断：max_tokens=${body.max_tokens}，推理占用 ${usage.reasoningTokens} tokens`,
    );
    return {
      ok: false,
      content,
      model,
      latencyMs: fullLatencyMs,
      ttfbMs,
      usage,
      rawRequest,
      rawResponse: payload,
      finishReason,
      errorKind: 'truncated',
      errorMessage: `输出被 max_tokens 截断（预算 ${body.max_tokens}，其中推理占用 ${usage.reasoningTokens}），需加大预算重试`,
    };
  }

  // 官方已知问题：JSON 模式偶尔返回空内容 —— 单独识别，交给上层重试
  if (!content || content.trim().length === 0) {
    console.warn(`[llm] ${request.label ?? 'call'} 返回空内容（finish_reason=${finishReason ?? 'unknown'}）`);
    return {
      ok: false,
      content: null,
      model,
      latencyMs: fullLatencyMs,
      ttfbMs,
      usage,
      rawRequest,
      rawResponse: payload,
      finishReason,
      errorKind: 'empty_content',
      errorMessage: '模型返回空内容（JSON 模式已知问题）',
    };
  }

  console.log(
    `[llm] ${request.label ?? 'call'} ok model=${model} ${fullLatencyMs}ms(首字节 ${ttfbMs}ms) tokens=${usage.promptTokens}+${usage.completionTokens}(推理 ${usage.reasoningTokens})`,
  );

  return {
    ok: true,
    content,
    model,
    latencyMs: fullLatencyMs,
      ttfbMs,
    usage,
    rawRequest,
    rawResponse: payload,
    finishReason,
  };
}
