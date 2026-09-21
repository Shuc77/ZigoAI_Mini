import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置（纯函数级）。
 *
 * 目标：把系统里"判断逻辑"的部分（状态机、跟进判定矩阵、规则守护、交接规则）
 * 用**不需要数据库、不需要网络**的方式测透 —— 它们是纯函数，也最容易出现"规则之间自相矛盾"的问题。
 *
 * 注意：部分被测模块会（间接）加载 env.ts 与 Prisma 客户端（模块初始化时校验必需变量），
 * 因此这里提供一组占位环境变量。测试本身不连接数据库、不发起网络请求。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:5432/unit_test',
      DEEPSEEK_API_KEY: 'unit-test-placeholder',
      SESSION_SECRET: 'unit-test-placeholder-secret-0123456789',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
