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

### 方式 A（推荐，不需要服务器 SSH 密码）：用 1Panel 文件管理上传

1. 打开 1Panel → 左侧 **文件** → 进入 `/opt` → 新建文件夹 `zigoai` → 双击进入
2. 右上角 **上传** → 选择本机文件 `zigoai-deploy-1.0.tar.gz` → 等上传完成
3. 确认该目录下已出现 `zigoai-deploy-1.0.tar.gz`

### 方式 B：本机 scp（需要服务器 SSH 密码/密钥）

在**你自己的 PowerShell** 里执行：

```powershell
ssh root@42.194.164.30 "mkdir -p /opt/zigoai"
scp D:\Desktop\ZigoAI\zigoai-deploy-1.0.tar.gz root@42.194.164.30:/opt/zigoai/
```

> 忘记 SSH 密码：腾讯云控制台 → 实例 → 重置密码（需重启生效）；用密钥对创建的实例则要用对应的私钥文件登录。
> **无论用哪种方式上传，后续所有命令都在 1Panel 自带的终端里执行即可。**

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

# 3) 启动数据库（端口只绑到宿主机回环地址，公网访问不到）
docker run -d --name zigoai-db --restart always --network zigoai-net \
  -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=zigoai \
  -e POSTGRES_PASSWORD=zigoai \
  -e POSTGRES_DB=zigoai \
  -v zigoai-pgdata:/var/lib/postgresql/data \
  postgres:16

# 4) 等数据库就绪
for i in $(seq 1 30); do docker exec zigoai-db pg_isready -U zigoai && break; sleep 2; done
# 预期：/var/run/postgresql:5432 - accepting connections
```

> `-p 127.0.0.1:15432:5432` 的含义：只有**服务器本机**能通过 15432 访问数据库，公网与局域网都连不上。
> 这样既能用图形化工具（见第 10 节），又不会像服务器上那个 5432 一样把数据库暴露在公网。

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

---

## 10. 人工处理数据库（查数、核对、订正）

### 10.1 最快的办法：容器内 psql（零暴露）

```bash
docker exec -it zigoai-db psql -U zigoai -d zigoai
```

常用命令：

```sql
\dt                                              -- 看所有表
\d "CustomerState"                               -- 看某张表结构
select name, "leadStage", intent, "needHuman", version from "CustomerState" cs
  join "Customer" c on c.id = cs."customerId";    -- 客户漏斗一览
select status, model, "latencyMs", "promptTokens", "completionTokens"
  from "AiSuggestion" order by "createdAt" desc limit 20;  -- AI 调用审计
\q                                               -- 退出
```

### 10.2 图形化工具（DBeaver / Navicat / pgAdmin）

数据库端口已绑定在宿主机 `127.0.0.1:15432`，用一条 SSH 隧道即可从本机连上：

```powershell
ssh -L 15432:127.0.0.1:15432 root@42.194.164.30
```

保持该窗口不要关，然后在图形工具里新建 PostgreSQL 连接：

| 字段 | 值 |
|---|---|
| Host | `localhost` |
| Port | `15432` |
| Database | `zigoai` |
| User / Password | `zigoai` / `zigoai` |

> Tomcat / Java 应用连库时，JDBC URL 同理：
> `jdbc:postgresql://127.0.0.1:15432/zigoai`（Tomcat 在宿主机）或
> `jdbc:postgresql://zigoai-db:5432/zigoai`（Tomcat 容器与 DB 同处 `zigoai-net` 网络），
> 驱动用 `postgresql-42.x.jar`。不过仅为"人工处理数据"而写一个 Java 应用性价比很低，隧道 + 图形工具更快。

### 10.3 ⚠️ 直接改数据的两个坑

1. **改 `CustomerState` 必须同时 `version = version + 1`** —— 这是乐观锁字段，不改会让并发保护失效。
2. **不要绕过应用直接改状态** —— 否则 `AiSuggestion` 里的"AI 建议了什么 / 人改成了什么"审计链会断。

改客户状态请优先用应用提供的人工操作接口：

```bash
# 需要带上登录后的会话 Cookie
curl -X POST -H "Content-Type: application/json" -H "Cookie: zigoai_session=<...>" \
  -d '{"action":"RESOLVE_HUMAN"}' \
  http://127.0.0.1:8080/api/customers/<客户id>/state
# action 可选：RESOLVE_HUMAN / CONFIRM_WON / CONFIRM_LOST / REOPEN
```

**适合直接上 SQL 的场景**：查数据、统计（采纳率/转人工率）、建索引、临时订正文案。
**不适合**：改销售阶段、改是否转人工、伪造 AI 判断记录。
