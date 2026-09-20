#!/usr/bin/env node
/**
 * 生成部署包：把应用镜像与数据库镜像**一起**打成 docker load 可直接读取的 tar.gz。
 *
 * 为什么把 Postgres 也打进去：
 *   国内服务器访问 Docker Hub / 官方仓库经常超时。把两个镜像一起交付，
 *   整个部署过程就完全不依赖服务器能否访问外网镜像仓库 —— 这是最稳的做法。
 *
 * 用法：
 *   node scripts/make-deploy-bundle.mjs                 # 默认 zigoai-mini:1.0 + postgres:16
 *   node scripts/make-deploy-bundle.mjs zigoai-mini:1.1
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const args = process.argv.slice(2);
const appOnly = args.includes('--app-only');
const appImage = args.find((a) => !a.startsWith('--')) ?? 'zigoai-mini:1.0';
const dbImage = process.env.POSTGRES_IMAGE ?? 'postgres:16';
const version = appImage.includes(':') ? appImage.split(':')[1] : 'latest';
const tarPath = `zigoai-deploy-${version}${appOnly ? '-app' : ''}.tar`;
const gzPath = `${tarPath}.gz`;

const mb = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;

// --app-only：只打包应用镜像，用于日常更新（数据库镜像服务器上已经有了，不必重复传 150MB）
const images = appOnly ? [appImage] : [appImage, dbImage];

console.log(`[bundle] 导出镜像：${images.join(' + ')}`);
execFileSync('docker', ['save', ...images, '-o', tarPath], { stdio: 'inherit' });
console.log(`[bundle] 原始大小 ${mb(tarPath)}，正在压缩…`);

await pipeline(createReadStream(tarPath), createGzip({ level: 6 }), createWriteStream(gzPath));
unlinkSync(tarPath);

console.log(`[bundle] 完成：${gzPath}（${mb(gzPath)}）`);
console.log('');
console.log('下一步：把包上传到服务器 /opt/zigoai/，然后执行');
console.log(`  docker load -i /opt/zigoai/${gzPath}`);
console.log(`  docker rm -f zigoai-mini`);
console.log(`  docker run -d --name zigoai-mini --restart always --network zigoai-net -p 8080:3000 --env-file /opt/zigoai/.env ${appImage}`);
