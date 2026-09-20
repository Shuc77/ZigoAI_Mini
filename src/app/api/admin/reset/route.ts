import { NextResponse } from 'next/server';
import { runSeed } from '../../../../../prisma/seed';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * 重置演示数据（幂等：重建两个演示租户，其它数据不动）。
 *
 * 为什么需要它：镜像里刻意不带 tsx 等开发依赖（保持精简），而部署后服务器上的数据库是空的，
 * 需要一个不依赖 CLI 的方式写入种子数据；顺便也成了"演示前一键恢复干净数据"的运维入口。
 *
 * 安全约束：
 *   ① 必须配置 SEED_TOKEN，否则接口直接 404（默认关闭，不给生产留后门）；
 *   ② 口令放在请求头 x-seed-token，不走 URL（避免进日志）；
 *   ③ 只重建演示租户，不触碰其它数据。
 */
export async function POST(request: Request) {
  if (!env.seedToken) {
    return NextResponse.json({ code: 'NOT_FOUND', message: '未启用该接口' }, { status: 404 });
  }

  const provided = request.headers.get('x-seed-token');
  if (provided !== env.seedToken) {
    return NextResponse.json({ code: 'FORBIDDEN', message: '口令不正确' }, { status: 403 });
  }

  try {
    const summary = await runSeed({ silent: true });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    console.error('[api/admin/reset] 失败', error);
    return NextResponse.json(
      { code: 'INTERNAL_ERROR', message: (error as Error).message },
      { status: 500 },
    );
  }
}
