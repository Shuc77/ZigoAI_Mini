# AGENTS.md · 在本仓库工作的 AI 编码代理约定

> 如果你是在这个仓库里工作的 AI 编码代理，**先读这一份，再动手**。这里不重复 `README.md`（那是给评审看的项目说明），
> 只写"在这个仓库里干活必须守什么、为什么"；人也可以拿它当 checklist。

> **本文件固化的是本项目开发过程中形成的约定 —— 每一条都对应一次真实踩坑，而不是事先写好的规则。**
>
> 这些约定是在 24 小时的开发与上线过程中被真实事故逼出来的：有一个提交带着 tsc 报错的代码就提交了（下一提交才补修）；
> 有一次用 PowerShell 整文件替换把 `AI_CODING_NOTES.md` 写坏（丢了 35 行、整节消失）；
> 同一个"测试总数"在不同文档里出现过互相对不上的数字；还有一次因为部署命令不是原子操作导致线上服务中断。
> 所以下面每一条都写清"为什么" —— **只写规则不写理由的约定，下一个人（或下一个 AI）一定会绕过去**。

---

## 1. 项目速览

- **技术栈**：Next.js 16（App Router）+ TypeScript strict + React 19 + Tailwind 4 + Prisma 7（`@prisma/adapter-pg`）+ PostgreSQL 16 + zod 4；ESM（`"type": "module"`），Node ≥ 22，包管理用 pnpm。
- **跑起来**：

  ```bash
  pnpm install
  cp .env.example .env                                  # 填 DATABASE_URL 与 DEEPSEEK_API_KEY
  pnpm db:generate && pnpm db:migrate && pnpm db:seed    # 建表 + 演示数据（2 企业 / 4 账号 / 6 客户 / 18 条消息）
  pnpm dev                                               # http://localhost:3000
  ```

- **代码地图**：判断逻辑全在 `src/lib/agent/`（`pipeline.ts` 唯一主干、`state.ts` 阶段状态机、`handoff.ts` 交接规则、`guards.ts` 规则守护、`batch.ts`/`batch-window.ts` 聚合窗口与补跑、`followup.ts` 跟进判定、`llm.ts` 模型调用）；界面与 API 在 `src/app/`；**数据访问必须走 `src/server/repositories/`**（多租户隔离的唯一入口）。
- **迁移与种子**：`prisma/migrations/` + 自研执行器 `scripts/db-migrate.mjs`（刻意不用 `prisma migrate deploy`）；`prisma/seed.ts` 全部按唯一键 upsert，**客户 id 永不变**。
- **先读哪些文档**：`docs/USER_MANUAL.md`（当前行为与 84 条用例）、`docs/DELIVERY_LOG.md`（M0–M12 里程碑的取舍与踩坑）、`docs/DEPLOY_1PANEL.md`（部署与回滚）。注意：DELIVERY_LOG 里的实测输出是**当时的历史快照**，不是当前值。

---

## 2. 改代码前后的硬性纪律

### 2.1 提交前必须跑 `pnpm typecheck && pnpm test`

本仓库真的出现过"先提交、后构建才发现类型错误"：提交 `1bfc0dd` 里 `call.estimatedCostCny`（类型 `number | null`）
直接调用了 `.toFixed(4)`，tsc 报 TS18047，到下一个提交 `ce86bf4` 才补上 `?? 0` —— 历史里因此多了一个**编译不过的提交**。

```bash
pnpm typecheck && pnpm test     # 两条都过，才允许写提交信息
```

类型错误属于"提交前零成本就能发现"的那一类，不能留给构建、CI 或下一个人。

### 2.2 改文档/文件一律用精确匹配的编辑工具（`edit`；整文件重写才用 `write`）

**禁止**用 PowerShell 的 `ReadAllText` / `Replace` / `WriteAllText` 做整文件字符串替换（`(Get-Content x -Raw).Replace(...) | Set-Content x` 这类写法）：
本仓库用这种方式批量改文档时，把 `AI_CODING_NOTES.md` 写坏过一次 —— **丢了 35 行、整节消失**（后靠 git 恢复）。
根因是含中文（CJK）的文件在 PowerShell 5.1 下做"读字符串 → 替换 → 写回"的往返会被编码与控制台转码破坏。
中文 Markdown 是本仓库的主要交付物之一，**改文档的风险和改代码一样高**；改完要核验章节是否还在，不能只看"命令没报错"。

### 2.3 改完必须验证：`git status --short` 里只应出现你刚改过的文件

```bash
git status --short
```

- 出现**意料之外的 `D`（删除）**：立刻停下来问人，**不要** `git add -A` 一把提交 —— 那会把误删一起提交上去。
- 出现意料之外的 `M`：先 `git diff <文件>` 看清是什么再决定；顺手格式化、凑数的改动一律回退。

---

## 3. 三层测试，与"数字的唯一来源"

### 3.1 三层各管一件事，改完都要跑

| 层 | 命令 | 测什么 |
|---|---|---|
| 单元（纯函数） | `pnpm test` | 阶段状态机、交接规则与自洽性、规则守护、聚合窗口分档、跟进判定矩阵、待办优先级 |
| Node 端到端 | `node scripts/smoke.mjs <url> --deepseek --seed-token=<口令>` | 真实 HTTP + 真实数据库 + **真实 AI 调用**：隔离、幂等、状态推进、规则注入、窗口分档 |
| 真实浏览器 | `node scripts/e2e-browser.mjs <url> --seed-token=<口令>` | 真实 Edge/Chrome：登录 → 发消息 → AI 卡片 → 连发合并 → 销售发送 → 跟进 → 重置后的加载态 |

```bash
# smoke 默认 http://127.0.0.1:3000；浏览器脚本默认 http://127.0.0.1:8083（端口不一致时务必显式传 URL）
node scripts/smoke.mjs http://127.0.0.1:3000 --deepseek
node scripts/e2e-browser.mjs http://127.0.0.1:8083 --seed-token=<口令>
BROWSER_CHANNEL=chrome node scripts/e2e-browser.mjs <url> --seed-token=<口令>   # 换浏览器
```

后台扫描（兜底批次 + 跟进）用 `pnpm agent:scan`；`package.json` 里的 `followup:scan` 指向并不存在的 `scripts/followup-scan.ts`，**不要用**。
`smoke.mjs` 会在「冒烟测试客户」名下累积测试消息 —— 演示前用 `pnpm db:seed`（本地）或 `POST /api/admin/reset`（幂等、id 稳定）恢复。

### 3.2 浏览器层不可省

本项目的 **4 个客户端问题只在真实浏览器暴露**，前两层全绿也照样漏：会话 Cookie 的 `Secure` 属性（HTTP 站点下浏览器直接丢弃 → 登录页死循环）、
`crypto.randomUUID` 在非 HTTPS 下不可用（点发送抛 `TypeError`，看起来像"按钮没反应"）、连发消息时输入框被锁死、`/ai-logs` 死链。
**测试客户端的真实程度决定了测试的有效性** —— 只要改了前端交互，第三层必须跑。

### 3.3 任何文档里的断言数字，都必须来自实测输出

- 单元数：跑 `pnpm test`，看它打印的 `Tests  N passed`；端到端 / 浏览器数：看脚本末尾的 `通过 N 项，失败 0 项`（静态看就是脚本里 `ok(` 的调用数）。
- **不许凭印象写、不许沿用上一版文档里的数字。** 本仓库出现过**同一件事在 4 份文档里写了 4 个不同数字**的情况，最后专门开一个提交（`e8327b5`）统一口径
  （当时 `AI_CODING_NOTES.md` 写的是 65/56/32，与其它文档不一致）。数字散落在多份文档里时，唯一可信来源只有一个：**跑出来的输出**。
- 当前口径（改动后请自行重跑核对）：单元 **75** / 端到端 **56** / 浏览器 **32**，合计 **163** 项；手册用例 **84** 条；里程碑 **M0–M12**。

---

## 4. 产品与文案纪律（本项目的核心原则）

### 4.1 AI 输出是建议，数据库状态是事实，中间必须由确定性代码裁决

- 模型**不能**把阶段写成终态（`WON`/`LOST` 只能人工确认）、**不能**让阶段回退、**不能**解除"需人工"；
- 企业红线由 `guards.ts` 用代码兜底，不能只写在提示词里；
- 每一处"系统改写了 AI 什么"都要落成可展示的修正记录（`stateAdjustments` / `handoffNotes`），否则卡片上的结论会与模型建议对不上，销售看到的就是自相矛盾；
- 改这一层时先问：**这条护栏拦下之后，有人被通知了吗？** "拦下"不等于"闭环"。

### 4.2 界面里不许写死时间 / 金额 / 条数

等待秒数必须由服务端返回的真实窗口决定（接口回传 `batchWindowMs` / `batchWindowReason`，界面照着显示）。
本项目踩过"文案写死约 8 秒"的坑：窗口后来改成自适应 2 / 3 / 8 秒，那句写死的文案立刻变成假话 —— **文案不能自己知道时间，只能复述服务端给的数字**。

### 4.3 文案必须与行为一字对应

"历史消息补跑"与"客户连发合并"是两件事，两种说明文案**互斥**，不能共用一句话；改了行为就同步改文案，改文案前先回去确认行为。
同理，客户可见 / 销售可见的状态必须自洽：不允许出现"状态说不需要人、动作却写着转人工"这类矛盾。

> 判断标准很简单：**如果一句话解释不了系统正在做的事，那它就是 bug**（哪怕功能本身是对的）。

---

## 5. 安全与运维

### 5.1 任何真实密钥不得写进任何受版本控制的文件

- 文档、示例、截图、提交信息里只放占位符（`<你的真实Key>`、`<口令>`）；凭据只进 `.env`（已在 `.gitignore`）与服务器上的 `/opt/zigoai/.env`（权限 600）。
- 本项目真的被 GitHub **Push Protection 拒过一次 push**（部署文档里写了真实 Key）。若密钥已进入历史：**不要只删文件，要改写提交**，让它从未进入历史。

### 5.2 部署：单行 `&&` 串联 + 切换前先 `ls` 校验 + 保留上一个镜像

```bash
# ① 先确认安装包真的到位（否则不要往下走）
ls -lh /opt/zigoai/zigoai-deploy-<版本>-app.tar.gz

# ② 一条命令完成切换：load 失败就不会删旧容器
cd /opt/zigoai && docker load -i zigoai-deploy-<版本>-app.tar.gz && docker rm -f zigoai-mini && docker run -d --name zigoai-mini --restart always --network zigoai-net -p 8080:3000 --env-file /opt/zigoai/.env zigoai-mini:<版本>

# ③ 回滚：一条命令切回上一个 tag（永远不要 docker rmi 旧镜像）
docker rm -f zigoai-mini && docker run -d --name zigoai-mini --restart always --network zigoai-net -p 8080:3000 --env-file /opt/zigoai/.env zigoai-mini:<上一个版本>
```

理由是一次真实事故：更新曾被拆成 `docker load` → `docker rm -f` → `docker run` 三条命令，上传没完成导致 `load` 失败，
**但 `docker rm -f` 照样执行** —— 旧容器被删、本地又没有新镜像，线上 8080 直接无监听。**部署步骤必须原子化，失败要停在破坏性动作之前**；
当时能 30 秒恢复，靠的唯一原因是旧镜像还在。另外：Web 终端会把多行粘贴合并成一行，交给别人执行的命令一律写成**单行、无续行符**。

---

## 6. 提交信息规范

- 中文，一行摘要：`类型: 一句话说清"改了什么、为什么"`，类型只用 `fix` / `feat` / `docs` / `chore` / `style`；
- 正文写**根因与验证方式**（怎么发现的、怎么复现、跑哪条命令验证的），不要只写"修复 bug"。仓库里合格的例子：
  `fix: "客户说不要了"被判成投诉 —— 补枚举 + 终态拦下后必须有人被通知`、`fix: 修正上一提交的类型错误（estimatedCostCny 可能为 null）`；
- **用 `git commit -F <message 文件>` 提交**：message 里带引号、反引号或换行时，`-m` 会被 shell 吃掉或转义出错。

---

## 7. 一次改动的标准动作（照着走就不会踩坑）

1. 读要改的文件与相邻的测试/文档 → 用精确匹配的编辑工具改（§2.2）→ `pnpm typecheck && pnpm test`；
2. 动了接口 / 前端 / 状态机 / 提示词 → 补跑 `smoke.mjs` 与 `e2e-browser.mjs`（§3.1）；
3. 改了行为 → 同步改文案与所有受影响的数字（数字来自实跑输出，§3.3）→ `git status --short` 核对改动面 → `git commit -F <message 文件>`；
4. 涉及部署 → 按 §5.2：先 `ls` 校验产物，再单行 `&&` 切换，并保留上一个镜像以便回滚。
