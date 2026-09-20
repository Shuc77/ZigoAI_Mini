import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 用于 Docker 部署：产物自包含，运行镜像只需 node + .next/standalone
  output: 'standalone',
  // Prisma 7 的客户端与驱动需要在服务端运行
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],
};

export default nextConfig;
