import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/lib/env';

/**
 * Prisma 7 使用 driver adapter（这里接 node-postgres）。
 * 好处：没有平台相关的引擎二进制，Docker 镜像里不会出现 openssl/平台不匹配问题。
 *
 * 单例模式：Next.js 开发模式会热重载模块，若不缓存会在每次改动时新建连接池。
 */
const globalForPrisma = globalThis as unknown as { __zigoaiPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__zigoaiPrisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.databaseUrl }),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__zigoaiPrisma = prisma;
}
