import 'dotenv/config';
import { sweepExpiredBatches } from '@/lib/agent/batch';
import { prisma } from '@/lib/db';

/**
 * 后台扫描（生产环境应由定时任务调用，例如每小时一次）。
 *
 * 目前负责：**连续消息合并的兜底扫描** —— 把"窗口已过期但尚未产生 AI 判断"的批次补跑掉。
 * 什么时候会出现这种批次：进程重启导致内存定时器丢失、或定时器回调异常退出。
 * 这正是"不能只依赖内存定时器"的落地（答辩要点）。
 *
 * 用法：
 *   pnpm agent:scan                 # 处理一次
 *   服务器上：docker exec zigoai-mini node scripts/agent-scan.mjs
 */
async function main() {
  const results = await sweepExpiredBatches(50);

  if (results.length === 0) {
    console.log('[scan] 没有待处理的批次');
  } else {
    console.log(`[scan] 补跑了 ${results.length} 个批次：`);
    for (const item of results) {
      console.log(`  batchId=${item.batchId.slice(0, 8)} 消息数=${item.messages}`);
    }
  }
}

main()
  .catch((error) => {
    console.error('[scan] 失败：', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
