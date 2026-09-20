import 'dotenv/config';
import { sweepExpiredBatches } from '@/lib/agent/batch';
import { scanFollowUps } from '@/lib/agent/followup';
import { prisma } from '@/lib/db';

/**
 * 后台扫描（生产环境应由定时任务调用，例如每 5 分钟一次）。
 *
 * 两件事：
 *   ① **连续消息合并的兜底扫描**：处理"窗口已过期但尚未产生 AI 判断"的批次；
 *      这类批次只在进程重启导致内存定时器丢失时出现。
 *   ② **Follow-up 扫描**：找出静默超时、且满足全部跟进条件的客户，生成跟进建议。
 *
 * 用法：
 *   pnpm agent:scan
 *   服务器上：docker exec zigoai-mini node scripts/agent-scan.mjs
 */
async function main() {
  console.log('[scan] 开始');

  const batches = await sweepExpiredBatches(50);
  console.log(
    batches.length === 0
      ? '[scan] 无待补跑的批次'
      : `[scan] 补跑 ${batches.length} 个批次：${batches
          .map((b) => `${b.batchId.slice(0, 8)}(${b.messages}条)`)
          .join('、')}`,
  );

  const followUps = await scanFollowUps({ limit: 200 });
  if (followUps.length === 0) {
    console.log('[scan] 无需要跟进的客户');
  } else {
    console.log(`[scan] 生成 ${followUps.length} 条跟进建议：`);
    for (const item of followUps) {
      console.log(`  ${item.customerName} —— ${item.reason}`);
    }
  }

  console.log('[scan] 完成');
}

main()
  .catch((error) => {
    console.error('[scan] 失败：', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
