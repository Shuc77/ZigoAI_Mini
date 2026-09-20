# ---------- 依赖安装 ----------
FROM node:22-slim AS deps
WORKDIR /app

# pnpm：与本地一致的版本，保证 lockfile 行为一致
RUN npm i -g pnpm@11.25.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile


# ---------- 构建 ----------
FROM node:22-slim AS builder
WORKDIR /app
RUN npm i -g pnpm@11.25.0

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建期占位环境变量：
# env.ts 在模块初始化时会校验必需变量（这是刻意的"启动即失败"设计），
# 但 next build 在收集页面/路由信息时会 import 到这些模块，因此构建阶段需要占位值。
# 真正的密钥只在运行时由容器注入，绝不进入镜像层。
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    DEEPSEEK_API_KEY="build-time-placeholder" \
    SESSION_SECRET="build-time-placeholder-secret" \
    NEXT_TELEMETRY_DISABLED=1

# build 脚本本身会先跑 prisma generate（生成的客户端不在仓库里）
RUN pnpm build


# ---------- 运行 ----------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nextjs

# Next standalone 产物：自带最小化的 node_modules（已 trace 出 pg / @prisma/client 等运行时依赖）
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 迁移文件 + 自研迁移执行器（容器启动时自动执行，幂等）
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/scripts/db-migrate.mjs ./scripts/db-migrate.mjs

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 先迁移再启动：数据库结构由容器自己保证，部署只需要一条 docker run
CMD ["sh", "-c", "node scripts/db-migrate.mjs && node server.js"]
