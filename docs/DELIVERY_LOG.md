# 交付日志 · ZigoAI Mini

> 每个功能点交付三样东西：**验收用例**（你可以照着点）、**功能总结**（做了什么/怎么实现/关键决策）、**答辩话术**（会被追问什么、怎么答）。
> 这份文件本身就是答辩时的"复习提纲"。

---

# M0 · 项目骨架 + 数据模型 + 鉴权 + 客户列表

时间：T+0:00 → T+2:00（含本地数据库搭建踩坑）

## 1. 功能总结

### 做了什么
- 建立可运行的全栈工程：Next.js 16（App Router）+ TypeScript + Tailwind 4 + Prisma 7 + PostgreSQL
- 设计并落地**7 张表**的完整数据模型（含索引、唯一约束、外键、乐观锁字段）
- 实现**真实账号 + 角色**的登录体系（scrypt 口令哈希 + jose 签名会话 Cookie）
- 实现**租户作用域仓储层**，作为多租户隔离的唯一入口
- 客户列表页（销售看自己名下、主管看本企业全部）
- 健康检查接口 + 可复用的端到端冒烟脚本

### 关键文件（30 秒定位表）
| 想找什么 | 打开这里 |
|---|---|
| 数据结构 / 为什么这么设计 | `prisma/schema.prisma` |
| 建表 SQL（权威） | `prisma/migrations/20260920200000_init/migration.sql` |
| 演示数据（2 企业 6 客户 18 条消息） | `prisma/seed.ts` |
| **租户隔离边界**（最重要的文件） | `src/server/repositories/customers.ts` |
| 登录 / 会话 | `src/lib/auth/password.ts`、`src/lib/auth/session.ts`、`src/server/auth.ts` |
| 页面守卫 | `src/server/auth.ts` |
| 迁移执行器（自研） | `scripts/db-migrate.mjs` |
| AI 客户端（含失败分类） | `src/lib/agent/llm.ts` |
| 端到端冒烟 | `scripts/smoke.mjs` |

### 关键决策与取舍

**1）为什么用 Prisma 7 + driver adapter（`@prisma/adapter-pg`）**
Prisma 7 的客户端是 Rust-free 的（查询编译器 WASM + 走 `pg` 驱动）。好处：Docker 镜像里**没有平台相关的引擎二进制**，不会出现 openssl 版本/架构不匹配这类部署期意外。代价：必须用 ESM（`"type": "module"`），并且生成器要显式写 `output`。

**2）为什么自己写迁移执行器，而不是 `prisma migrate deploy`**
`prisma migrate` 会拉起 `schema-engine` 原生子进程。自研 60 行执行器（`scripts/db-migrate.mjs`）带来三个好处：
- 运行时镜像不需要打包 Prisma CLI（镜像更小、启动更快）
- 迁移文件仍是 **Prisma 标准格式**，`prisma migrate diff/deploy` 在别处依然可用
- 记账表沿用 `_prisma_migrations` 结构，工具链信息一致；并额外做**checksum 校验**：历史迁移被改动会直接报错退出，防止"线上库与仓库漂移"

**3）为什么自己实现会话，而不是 NextAuth**
需求只有三点：登录、带租户上下文的会话、登出。手写 60 行完全可解释；而 NextAuth 的配置面、回调链、适配器在 24H 内是纯粹的心智负担，也会让"现场改需求"变慢。

**4）为什么隔离做在仓储层**
`tenantId` 只来自**服务端签名**的会话，任何请求体/URL 里的租户 id 一律忽略。所有查询都必须经过 `customerScope(ctx)`，结构上杜绝"某次查询忘了加 where"导致的越权。

**5）枚举值为什么用中文**
`customer_intent` / `next_action` 这些值既会进入 prompt，也会直接显示给销售。用中文可避免"枚举值再翻译一遍"造成的语义漂移，AI 日志页也能肉眼比对。

## 2. 验收用例（照着点即可）

前置：开发服务器已启动（`pnpm dev`），浏览器打开 http://localhost:3000

| # | 操作 | 预期结果 | 失败判定 |
|---|---|---|---|
| 1 | 打开 http://localhost:3000 | 自动跳转到 `/login` | 停在空白页或报错 |
| 2 | 点击账号气泡 `sales@lemeng.demo` → 登录 | 进入客户列表，右上角显示 `乐蒙亲子游泳` + `销售` 标签 | 提示"邮箱或密码不正确" |
| 3 | 查看列表 | 只有 **张女士 / 刘先生 / 陈女士** 三位 | 出现机械之家的客户（王老板等）→ 隔离失效 |
| 4 | 查看阶段列 | 张女士=有意向、刘先生=探需中、陈女士=有意向 **且带"建议人工介入"橙标** | 阶段全为空或标注缺失 |
| 5 | 点右上角"退出登录" | 回到登录页；此时手动访问 `/customers` 会再次被踢回登录页 | 未登录仍能看到客户列表 |
| 6 | 填入 `sales@jixie.demo` / `Zigo@2026` 登录 | 看到 **王老板 / 李工 / 黄总**，右上角显示 `机械之家` | 看到乐蒙的客户 |
| 7 | 再退登，用 `manager@lemeng.demo` 登录 | 同样只看到乐蒙三位客户（主管看本企业全部） | 看到机械之家客户 |
| 8 | 访问 http://localhost:3000/api/health | `{"ok":true,...}`，`database.ok=true` | `ok:false` |
| 9 | 访问 http://localhost:3000/api/health?deepseek=1 | `checks.deepseek.ok=true`，含模型名、耗时、token 数 | `ok:false` 或超时 |

**自动化版（一条命令覆盖 1–3、6–9）**
```bash
node scripts/smoke.mjs --deepseek
```

实测输出（M0 完成时）：
```
健康检查
  ✓ 服务与数据库正常 — db 98ms, 模型 deepseek-flash
  ✓ DeepSeek 真实调用成功 — deepseek-flash 239ms, tokens 95+169
认证
  ✓ 错误密码被拒绝 — HTTP 401
  ✓ 正确密码可登录 — 乐蒙亲子游泳
  ✓ 未登录访问业务页被重定向 — HTTP 307 → /login
租户隔离与角色作用域
  ✓ sales@lemeng.demo 可见范围正确 — 看到 张女士、刘先生、陈女士
  ✓ sales@jixie.demo 可见范围正确 — 看到 王老板、李工、黄总
  ✓ manager@lemeng.demo 可见范围正确 — 看到 张女士、刘先生、陈女士
[smoke] 通过 8 项，失败 0 项
```

## 3. 已知问题（主动交代）

1. **`User.email` 全局唯一**（而非租户内唯一）：这是为简化登录做的取舍。生产环境应改为"先选企业/用子域名或 SSO 定位租户"，再按 `(tenantId, email)` 唯一。已写入 README 的 Assumptions。
2. **本地开发库是 PostgreSQL 12**（复用机器上已有的二进制、跑在 5433、数据目录 `.localdb/` 且不入库），生产用 1Panel 的较新版本。本项目只用基础类型 + jsonb + 唯一索引，两版行为一致。
3. **会话 12 小时固定有效期**，没有实现滑动续期与主动吊销列表。
4. **健康检查接口未鉴权**（刻意为之，用于部署后免登录验证），但它只返回进程/数据库/模型状态，不返回任何业务数据。

## 4. 答辩话术

**Q：Customer State 为什么和 Customer 分开两张表？**
A：两者的变更频率与用途完全不同。Customer 是相对静态的档案（姓名、微信号、归属人），CustomerState 是每次 AI 判断都会写入的销售状态（阶段、意图、是否需人工、最后联系时间、跟进次数）。分开以后：① 乐观锁 `version` 只作用于状态更新这一小块，冲突面小；② 客户档案的读写不会被高频状态写入影响；③ 状态表的索引可以专门为"按阶段筛选""按最后消息时间找待跟进"设计。

**Q：lead_stage 为什么是这六个？**
A：它映射的是**真实销售漏斗**，而且我把它做成了**有序**的（`STAGE_ORDER`），这样"阶段只能前进、WON/LOST 是终态不允许 AI 自动改动"才能写成可测试的规则，而不是指望模型自觉。NEW=刚进线，DISCOVERY=探需，INTERESTED=有明确意向，HIGH_INTENT=高意向待成交，WON/LOST=终态需人工确认。

**Q：多租户隔离你怎么保证？**
A：隔离不是靠"每个查询记得加 where"，而是靠结构：所有数据访问必须经过 `src/server/repositories/*`，而这些函数的第一个参数强制是 `AuthContext`，作用域由 `customerScope(ctx)` 统一生成；`tenantId` 只来自服务端签名的 Cookie，前端传什么都不看。跨企业访问查不到数据 → 上层统一转 404，连"这个 id 存在但不属于你"都不暴露。并且 `scripts/smoke.mjs` 里有专门的越权断言，回归时会自动跑。

**Q：如果业务量增加 100 倍？**
A：① 数据库层面：本项目所有查询都带 `tenantId` 前缀的复合索引，天然按租户分片友好，可以按 `tenantId` 做分区或分库；② 应用层面：现在是单实例，聚合窗口和跟进扫描是进程内实现，100 倍量级要换成 Redis/队列（这也是我在 README 里写清的演进路径）；③ AI 调用层面：`AiSuggestion` 已经记录了每次调用的 prompt/响应/token/耗时，可以直接算单位经济模型，并据此做缓存（相同客户状态+相同消息批次的判断结果可复用）与限流。

**Q：这个阶段你最不满意的地方？**
A：`User.email` 全局唯一这个简化。它在演示里没问题，但真实 SaaS 里同一个邮箱可能在多个企业下都存在，正确做法是把登录入口和租户定位分开。我把它列进了 Known Issues 和 Next 3 Days。

## 5. 本次踩坑记录（会写进 AI_CODING_NOTES）

**DeepSeek JSON 模式 + `max_tokens` 的真实坑**：健康检查第一次返回了 `empty_content`（AI 调用返回空字符串）。我没有当作"偶发"，而是把 `finish_reason` 打进日志，一眼看到是 `finish_reason=length`：`deepseek-flash` 会先花约 45–57 个 token 做**推理**，这部分计入 `completion_tokens`。我原本只给健康检查留了 `max_tokens=100`，预算被推理吃光，JSON 整段为空。

由此形成两条**通用规则**（已在 `src/lib/agent/llm.ts` 落地，M2 的 pipeline 直接受益）：
1. 把 `finish_reason === 'length'` 单独识别为 `truncated` 错误类型 —— 它与"偶发空内容"不同：前者要**加大预算**重试，后者原参数重试即可；
2. 所有 AI 调用的原始请求/响应/耗时/token/推理 token 全部入库，排障不靠猜。
