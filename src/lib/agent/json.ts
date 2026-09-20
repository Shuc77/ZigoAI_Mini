/**
 * 从模型输出里"抢救"出 JSON 对象。
 *
 * 现实里即使开了 response_format=json_object，模型仍可能：
 *   - 包一层 ```json 代码块
 *   - 前后带一句解释性文字
 * 因此解析要宽容，**校验要严格**（校验交给 zod，不在这里做）。
 */
export function parseLooseJson(content: string): unknown {
  const trimmed = content.trim();

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = tryParse(fenceMatch[1].trim());
    if (fenced !== undefined) return fenced;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
    if (sliced !== undefined) return sliced;
  }

  return undefined;
}

function tryParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
