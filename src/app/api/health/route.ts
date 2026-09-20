import { NextResponse } from 'next/server';
import { callDeepSeekJson } from '@/lib/agent/llm';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 健康检查：部署验证与排障的入口。
 *
 * GET /api/health              → 只检查进程与数据库（便宜、快速）
 * GET /api/health?deepseek=1   → 额外做一次真实的 DeepSeek JSON 调用（验证 Key、网络、模型、JSON 模式）
 *
 * 刻意不返回任何业务数据（客户数、租户名等），避免公网裸奔时泄露信息。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const checkLlm = url.searchParams.get('deepseek') === '1';

  const checks: Record<string, unknown> = {};
  let allOk = true;

  // 1) 环境变量齐备性（只报名字，不回显值）
  const missing = ['DATABASE_URL', 'DEEPSEEK_API_KEY', 'SESSION_SECRET'].filter(
    (name) => !process.env[name],
  );
  checks.env = { ok: missing.length === 0, missing };
  if (missing.length > 0) allOk = false;

  // 2) 数据库连通性
  try {
    const startedAt = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    allOk = false;
    checks.database = { ok: false, error: (error as Error).message };
  }

  // 3) 可选：真实调用一次 DeepSeek
  if (checkLlm) {
    const result = await callDeepSeekJson({
      label: 'health-check',
      system:
        '你是一个连通性检查助手。必须输出 json 对象，字段 ok（布尔）与 note（字符串）。示例：{"ok":true,"note":"ok"}',
      user: '请返回一个表示服务正常的 json。',
      // 注意：deepseek-flash 会先花约 50 个 token 做推理，预算给小了会因 finish_reason=length 返回空内容
      maxTokens: 500,
      temperature: 0,
    });
    checks.deepseek = {
      ok: result.ok,
      model: result.model,
      latencyMs: result.latencyMs,
      errorKind: result.errorKind,
      errorMessage: result.errorMessage,
      tokens: result.usage,
    };
    if (!result.ok) allOk = false;
  }

  return NextResponse.json(
    {
      ok: allOk,
      service: 'zigoai-mini',
      model: env.deepseekModel,
      time: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 },
  );
}
