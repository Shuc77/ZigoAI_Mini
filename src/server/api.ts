import { NextResponse } from 'next/server';
import { HttpError } from '@/lib/errors';

/**
 * 接口层的统一收尾：把 HttpError 映射成 { code, message } + 状态码，
 * 未预期错误统一 500 并打日志（不打日志的 500 是排障噩梦）。
 */
export function jsonError(error: unknown, scope: string) {
  if (error instanceof HttpError) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
  }
  console.error(`[api/${scope}] 未预期错误`, error);
  return NextResponse.json(
    { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试' },
    { status: 500 },
  );
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}
