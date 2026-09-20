# 1Panel 部署手册 · ZigoAI Mini

> 目标：把 ZigoAI Mini 跑在腾讯云服务器 `42.194.164.30` 的 **8080** 端口，浏览器直接可访问，
> 且**不影响现有 80 端口项目**（岭南智韵）与 5432 端口上的既有服务。
>
> 分工：本手册的命令由你在 1Panel 终端执行；每步都有「预期输出」，不对就停下来把输出发我。
> 我这边已用**完全相同的拓扑**在本地干跑通过（36 项端到端断言全绿），流程本身是验证过的。

---

## 0. 架构

```
浏览器 ──http://42.194.164.30:8080──▶ [zigoai-mini :3000]
                                            │ zigoai-net（Docker 内部网络）
                                            ▼
                                     [zigoai-db :5432]（不对公网暴露）
```

| 项 | 取值 | 说明 |
|---|---|---|
| 应用端口 | 宿主 `8080` → 容器 `3000` | 现有 80/443/5432 一律不动 |
| 数据库 | **我们自己带的** postgres:16 容器 | 不映射宿主端口，只走 Docker 内部网络（5432 已被别的服务占用，我们完全不碰） |
| 数据卷 | `zigoai-pgdata` | 容器重建数据不丢 |
| 密钥 | `/opt/zigoai/.env`（权限 600） | 只在服务器上，绝不进镜像与仓库（连本手册里的 Key 都是占位符） |
| 镜像获取 | 我导出的 `zigoai-deploy-1.0.tar.gz` | **服务器无需访问任何镜像仓库**（国内拉 Docker Hub 经常超时） |

---

## 1. 上传部署包

部署包在**你本机**：`D:\Desktop\ZigoAI\zigoai-deploy-1.0.tar.gz`（241 MB，含应用镜像 + Postgres 镜像）。

在**你自己的 PowerShell** 里执行（不是 1Panel 终端；会提示输入服务器密码）：

```powershell
ssh root@42.194.164.30 "mkdir -p /opt/zigoai"
scp D:\Desktop\ZigoAI\zigoai-deploy-1.0.tar.gz root@42.194.164.30:/opt/zigoai/
```

> 若服务器 SSH 用户不是 `root`，请替换；也可以用 1Panel 的「文件」功能上传到 `/opt/zigoai/`。

---

## 2. 载入镜像并启动数据库

在 **1Panel 终端**依次执行：

```bash
cd /opt/zigoai

# 1) 载入两个镜像（应用 + Postgres）
docker load -i zigoai-deploy-1.0.tar.gz
# 预期：Loaded image: zigoai-mini:1.0  /  Loaded image: postgres:16

# 2) 建专用网络
docker network create zigoai-net

# 3) 启动数据库（不映射任何端口到公网）
docker run -d --name zigoai-db --restart always --network zigoai-net \
  -e POSTGRES_USER=zigoai \
  -e POSTGRES_PASSWORD=zigoai \
  -e POSTGRES_DB=zigoai \
  -v zigoai-pgdata:/var/lib/postgresql/data \
  postgres:16

# 4) 等数据库就绪
for i in $(seq 1 30); do docker exec zigoai-db pg_isready -U zigoai && break; sleep 2; done
# 预期：/var/run/postgresql:5432 - accepting connections
```

---

## 3. 写环境变量

```bash
# 生成会话密钥（复制输出的那串十六进制）
openssl rand -hex 32

cat > /opt/zigoai/.env <<'EOF'
DATABASE_URL="postgresql://zigoai:zigoai@zigoai-db:5432/zigoai"
DEEPSEEK_API_KEY="把你自己在 DeepSeek 控制台创建的 Key 粘到这里"
DEEPSEEK_BASE_URL="https://api.deepseek.com"
DEEPSEEK_MODEL="deepseek-flash"
DEEPSEEK_MODEL_PRO="deepseek-v4-pro"
DEEPSEEK_TIMEOUT_MS="20000"
DEEPSEEK_PRICE_IN_PER_MTOK="0"
DEEPSEEK_PRICE_OUT_PER_MTOK="0"
SESSION_SECRET="把上面 openssl rand 生成的串粘到这里"
SEED_TOKEN="zigoai-demo-reset"
MESSAGE_BATCH_WINDOW_MS="8000"
FOLLOWUP_IDLE_MINUTES="2"
FOLLOWUP_MAX_ATTEMPTS="2"
EOF

chmod 600 /opt/zigoai/.env
```

> 数据库密码用纯字母数字 `zigoai`，避免 URL 编码问题；演示环境足够，生产请换强密码并同步改 `DATABASE_URL` 与 `POSTGRES_PASSWORD`。

---

## 4. 启动应用

```bash
docker run -d --name zigoai-mini --restart always --network zigoai-net \
  -p 8080:3000 \
  --env-file /opt/zigoai/.env \
  zigoai-mini:1.0

# 看启动日志（容器会**自动执行数据库迁移**）
sleep 12 && docker logs --tail 25 zigoai-mini
```

**预期输出**（关键两行）：
```
[migrate] 共应用 4 个迁移
✓ Ready in 0ms
```

---

## 5. 放行 8080（两处都要）

1. **腾讯云控制台** → 轻量应用服务器/云服务器 → 防火墙 / 安全组 → 入站规则：`TCP 8080`，来源 `0.0.0.0/0`
2. **1Panel** → 防火墙 → 放行 `8080/TCP`

验证本机可达：

```bash
curl -s http://127.0.0.1:8080/api/health
# 预期：{"ok":true,...,"checks":{"database":{"ok":true,...}}}
```

---

## 6. 写入演示数据（容器内一键）

```bash
curl -s -X POST -H "x-seed-token: zigoai-demo-reset" http://127.0.0.1:8080/api/admin/reset
# 预期：{"ok":true,"summary":{"tenants":2,"users":4,"customers":6,"messages":18,...}}
```

这个接口是**幂等**的：随时可以再调一次，把演示数据恢复干净（演示前建议先调一次）。
出于安全，它只在配置了 `SEED_TOKEN` 时启用，且口令走请求头而不是 URL。

---

## 7. 验收（我这边执行）

你把上面步骤跑完告诉我，我会从公网做完整验收：

```bash
node scripts/smoke.mjs http://42.194.164.30:8080
node scripts/smoke.mjs http://42.194.164.30:8080 --deepseek
```

**预期**：36 项全绿，并且你能在浏览器打开 `http://42.194.164.30:8080` 用演示账号登录。

---

## 8. 后续更新（每次改代码）

```bash
# 本机
docker build --platform linux/amd64 -t zigoai-mini:1.1 .
node scripts/make-deploy-bundle.mjs zigoai-mini:1.1
scp zigoai-deploy-1.1.tar.gz root@42.194.164.30:/opt/zigoai/

# 服务器
cd /opt/zigoai && docker load -i zigoai-deploy-1.1.tar.gz
docker rm -f zigoai-mini
docker run -d --name zigoai-mini --restart always --network zigoai-net \
  -p 8080:3000 --env-file /opt/zigoai/.env zigoai-mini:1.1
```

数据库数据在 `zigoai-pgdata` 卷里，重建应用容器不受影响。

---

## 9. 排错速查

| 现象 | 处理 |
|---|---|
| 日志 `缺少环境变量 X` | `docker exec zigoai-mini env \| grep -E 'DATABASE_URL\|SESSION_SECRET'` 确认变量进去了 |
| 日志 `数据库连接失败` | `docker network inspect zigoai-net` 确认两个容器都在；容器名必须是 `zigoai-db` |
| 公网打不开、本机 curl 可以 | 安全组或 1Panel 防火墙没放行 8080 |
| 页面 500 | `docker logs zigoai-mini` 看 `[migrate]`；必要时 `docker exec zigoai-mini node scripts/db-migrate.mjs` |
| 登录后立刻被踢回 | `.env` 里 `SESSION_SECRET` 为空或太短 |
| 想重置演示数据 | `curl -s -X POST -H "x-seed-token: zigoai-demo-reset" http://127.0.0.1:8080/api/admin/reset` |
