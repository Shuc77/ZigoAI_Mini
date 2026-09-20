#!/usr/bin/env node
/**
 * 极简迁移执行器（替代 `prisma migrate deploy`）
 *
 * 为什么自己写（这是主动取舍，README 里会写）：
 * 1) Prisma CLI 的 migrate 子命令会拉起 schema-engine 原生子进程；在受限环境（我们的开发沙箱）
 *    以及为了给生产镜像瘦身，我们希望运行时只依赖 Node + pg 驱动。
 * 2) 迁移文件本身仍是 Prisma 标准格式（prisma/migrations/<timestamp>_<name>/migration.sql），
 *    因此 `prisma migrate diff` 生成、`prisma migrate deploy` 在别处执行都完全兼容。
 * 3) 记账表沿用 Prisma 的 _prisma_migrations 结构，保证工具链信息一致（Prisma Studio / CLI 仍能读懂）。
 *
 * 行为：
 *   - 按目录名升序应用尚未执行的迁移，每个迁移在**单个事务**内执行并记账；
 *   - 已执行迁移的内容若被改动（checksum 不一致）直接报错退出 —— 防止"线上库与仓库漂移"；
 *   - 幂等：重复执行不会重复应用。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'prisma', 'migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[migrate] 缺少 DATABASE_URL（本地可用 node --env-file=.env 运行）');
  process.exit(1);
}

const CREATE_BOOKKEEPING_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  VARCHAR(36)  PRIMARY KEY NOT NULL,
  "checksum"            VARCHAR(64)  NOT NULL,
  "finished_at"         TIMESTAMPTZ,
  "migration_name"      VARCHAR(255) NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      TIMESTAMPTZ,
  "started_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER      NOT NULL DEFAULT 0
)`;

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(CREATE_BOOKKEEPING_TABLE);

    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    if (names.length === 0) {
      console.log('[migrate] prisma/migrations 下没有迁移目录，跳过');
      return;
    }

    const { rows: applied } = await client.query(
      'SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    const appliedMap = new Map(applied.map((r) => [r.migration_name, r.checksum]));

    let appliedNow = 0;
    for (const name of names) {
      const sqlPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
      const sql = await readFile(sqlPath, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      const previous = appliedMap.get(name);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `[migrate] 迁移 ${name} 已执行过，但文件内容已变化（checksum 不一致）。` +
              `请新增一个迁移文件来修改结构，而不是改动历史迁移。`,
          );
        }
        console.log(`[migrate] 跳过（已应用） ${name}`);
        continue;
      }

      console.log(`[migrate] 应用 ${name} ...`);
      const startedAt = new Date();
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO "_prisma_migrations"
             ("id","checksum","finished_at","migration_name","started_at","applied_steps_count")
           VALUES ($1,$2,now(),$3,$4,$5)`,
          [crypto.randomUUID(), checksum, name, startedAt, 1],
        );
        await client.query('COMMIT');
        appliedNow += 1;
        console.log(`[migrate] 完成 ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`[migrate] 迁移 ${name} 失败，已回滚：${error.message}`);
      }
    }

    console.log(
      appliedNow === 0
        ? '[migrate] 数据库已是最新，无需迁移'
        : `[migrate] 共应用 ${appliedNow} 个迁移`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
