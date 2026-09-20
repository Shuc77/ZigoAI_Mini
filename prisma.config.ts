import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 起，数据源 URL 与迁移/种子命令都收敛到 prisma.config.ts。
// 注意：这里用 dotenv 显式加载 .env（Next.js 会自己读 .env，但 Prisma CLI 与脚本不会）。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    // Node 22 原生支持剥离类型，因此种子脚本直接用 node 执行，不引入 tsx
    seed: 'node prisma/seed.ts',
  },
});
