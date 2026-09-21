-- 为所有表与字段补上数据库注释（Navicat / DBeaver / psql \d+ 里都能直接看到）
--
-- 为什么用 DO 块 + information_schema 判断，而不是直接写一堆 COMMENT ON：
--   直接写的话，只要有一个列名与当前库不一致，整条迁移就会失败 ——
--   而容器是"迁移失败就不启动"，代价太大。这里改成"存在才注释，不存在就跳过"，
--   于是这份迁移在任何历史版本的库上都能安全执行（幂等、可重复跑）。

-- ---------------- 表注释 ----------------
COMMENT ON TABLE "Tenant" IS '企业（租户）：档案 + 企业规则 + 交接规则。系统的第一层隔离边界';
COMMENT ON TABLE "User" IS '账号：销售/主管，密码 scrypt 哈希，会话存 httpOnly Cookie';
COMMENT ON TABLE "Customer" IS '客户档案：归属某个销售（SALES 只能看自己名下的）';
COMMENT ON TABLE "Message" IS '聊天记录：CUSTOMER/SALES 双向，带幂等键与"连续消息合并"批次号';
COMMENT ON TABLE "CustomerState" IS '客户状态（事实）：阶段/意图/是否需人工/版本号。与 AiSuggestion 严格区分——这里存状态机裁决后的结果';
COMMENT ON TABLE "AiSuggestion" IS 'AI 判断 + 完整调用审计：六个输出字段、规则守护结果、系统改写记录、原始请求响应、分段耗时。可回放到具体某一次判断';
COMMENT ON TABLE "FollowUpTask" IS '跟进任务：客户静默超时后的跟进，attempt 为幂等键防止重复打扰';
COMMENT ON TABLE "_prisma_migrations" IS 'Prisma 迁移历史（由 Prisma 维护）';

-- ---------------- 字段注释（存在才注释） ----------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Tenant
      ('Tenant','id','主键'),
      ('Tenant','name','企业名称，例如"乐蒙亲子游泳"'),
      ('Tenant','slug','企业短标识；种子数据按它 upsert，因此重置数据不会改变租户 id'),
      ('Tenant','salesGoal','销售目标（注入 prompt），例如"推动预约线下体验课"'),
      ('Tenant','tone','沟通语气（注入 prompt）'),
      ('Tenant','rules','企业规则数组 [{id,text,guard?}]；逐条编号注入 prompt，guard 是机器可校验的规则码'),
      ('Tenant','forbidden','明文禁止项数组（注入 prompt 的"明确禁止"段）'),
      ('Tenant','handoff','交接规则：triggers（7 类触发器开关）/ keywords（敏感词）/ amountThreshold（金额阈值）'),
      ('Tenant','createdAt','创建时间'),
      ('Tenant','updatedAt','更新时间'),
      -- User
      ('User','id','主键'),
      ('User','tenantId','所属企业'),
      ('User','email','登录邮箱（唯一）；种子按它 upsert'),
      ('User','name','姓名'),
      ('User','passwordHash','scrypt 密码哈希（含盐），绝不明文存储'),
      ('User','role','角色：SALES 只能看自己名下客户；MANAGER 可看全企业并修改企业规则'),
      ('User','createdAt','创建时间'),
      ('User','updatedAt','更新时间'),
      -- Customer
      ('Customer','id','主键；地址栏 /customers/<id> 用的就是它，重置数据不会改变'),
      ('Customer','tenantId','所属企业'),
      ('Customer','name','客户称呼'),
      ('Customer','handle','微信号（租户内业务唯一键，种子按 tenantId+handle upsert）'),
      ('Customer','phone','电话'),
      ('Customer','source','来源，例如"老客户转介绍"'),
      ('Customer','note','备注'),
      ('Customer','assigneeId','负责销售；SALES 角色只能看到 assigneeId = 自己的客户'),
      ('Customer','createdAt','创建时间'),
      ('Customer','updatedAt','更新时间'),
      -- Message
      ('Message','id','主键'),
      ('Message','tenantId','所属企业'),
      ('Message','customerId','所属客户'),
      ('Message','role','发送方：CUSTOMER=客户，SALES=销售'),
      ('Message','content','消息正文'),
      ('Message','senderUserId','发送该消息的销售账号（role=SALES 时才有值）'),
      ('Message','batchId','"连续消息合并"的批次号：同一批只调用一次 AI'),
      ('Message','clientMessageId','客户端幂等键；同租户内重复提交只落库一次'),
      ('Message','createdAt','发送时间'),
      -- CustomerState
      ('CustomerState','id','主键'),
      ('CustomerState','tenantId','所属企业'),
      ('CustomerState','customerId','所属客户（唯一：一个客户只有一份当前状态）'),
      ('CustomerState','leadStage','销售阶段：NEW→DISCOVERY→INTERESTED→HIGH_INTENT→WON/LOST。顺序化，因此"只能前进不能回退"是代码规则而非模型自觉'),
      ('CustomerState','intent','当前意图（最近一次判断的结果）'),
      ('CustomerState','needHuman','是否需人工：只升不降，只能由人工操作解除'),
      ('CustomerState','humanReason','需人工的原因，例如"客户投诉""客户流失倾向"'),
      ('CustomerState','lastContactAt','最后一次往来时间'),
      ('CustomerState','lastCustomerMessageAt','客户最后一次说话的准确时间——跟进扫描的判定依据'),
      ('CustomerState','followUpCount','已跟进次数（业务计数；客户再次发言时归零）'),
      ('CustomerState','lastFollowUpAt','上次跟进时间（冷却期判定用）'),
      ('CustomerState','version','乐观锁版本号：每次落库 +1，冲突则重试，防止并发覆盖'),
      ('CustomerState','updatedAt','更新时间'),
      -- AiSuggestion
      ('AiSuggestion','id','主键（也是"判断链路"页的 URL 参数）'),
      ('AiSuggestion','tenantId','所属企业'),
      ('AiSuggestion','customerId','所属客户'),
      ('AiSuggestion','batchId','本轮判断对应的批次号（一批次一次判断）'),
      ('AiSuggestion','customerIntent','【AI 输出】客户意图'),
      ('AiSuggestion','intentDetail','【AI 输出】意图补充说明'),
      ('AiSuggestion','leadStage','【落库阶段】状态机裁决后的阶段（可能与 AI 建议不同）'),
      ('AiSuggestion','nextAction','【AI 输出】下一步动作'),
      ('AiSuggestion','reply','【AI 输出】建议回复（销售可以直接发出去的那句话）'),
      ('AiSuggestion','reason','【AI 输出】判断依据'),
      ('AiSuggestion','needHuman','最终是否需要人工（AI 建议 + 交接策略裁决的结果）'),
      ('AiSuggestion','humanReason','需要人工的原因'),
      ('AiSuggestion','rulesApplied','【AI 输出】模型自述引用了哪几条企业规则，用于证明规则真的影响了判断'),
      ('AiSuggestion','trigger','触发来源：NEW_MESSAGE 客户新消息 / REGENERATE 手动重判 / FOLLOW_UP 静默跟进 / INITIAL_BACKFILL 首次判断补跑'),
      ('AiSuggestion','handoffNotes','交接规则的触发说明：为什么升级人工（敏感词/金额阈值/终态需确认等）'),
      ('AiSuggestion','stateAdjustments','系统对 AI 建议的修正记录：AI 建议了什么、系统采纳了什么、依据哪条规则'),
      ('AiSuggestion','ruleViolation','规则守护发现的违规（生成后确定性校验的结果）'),
      ('AiSuggestion','status','本次调用健康度：SUCCESS / RETRY_OK / FALLBACK(已降级为人工) / ERROR'),
      ('AiSuggestion','model','实际使用的模型'),
      ('AiSuggestion','promptVersion','提示词版本号'),
      ('AiSuggestion','rawRequest','送进模型的原始请求（含完整 prompt，可回放）'),
      ('AiSuggestion','rawResponse','模型的原始输出'),
      ('AiSuggestion','pipelineTrace','判断链路：分段耗时 + 每一步的输入输出（"查看链路"页的数据源）'),
      ('AiSuggestion','latencyMs','模型真实耗时（响应体读完才计时；不等于首字节时间）'),
      ('AiSuggestion','promptTokens','输入 token'),
      ('AiSuggestion','completionTokens','输出 token（含推理 token）'),
      ('AiSuggestion','estimatedCostCny','估算成本（元）；单价未配置时为 0'),
      ('AiSuggestion','retryCount','重试次数（含截断后放大预算的重试）'),
      ('AiSuggestion','errorMessage','失败原因（分类后的错误信息）'),
      ('AiSuggestion','sentMessageId','销售实际发出的那条消息 id —— "AI 建议 → 人工修改 → 实际发送"的追溯链'),
      ('AiSuggestion','finalReply','销售实际发出的文本；与 reply 不同即说明人工改过'),
      ('AiSuggestion','sentAt','发送时间'),
      ('AiSuggestion','createdAt','判断产生时间'),
      -- FollowUpTask
      ('FollowUpTask','id','主键'),
      ('FollowUpTask','tenantId','所属企业'),
      ('FollowUpTask','customerId','所属客户'),
      ('FollowUpTask','status','任务状态：PENDING / SENT / SKIPPED / CANCELLED'),
      ('FollowUpTask','dueAt','计划跟进时间'),
      ('FollowUpTask','reason','为什么跟进（或为什么跳过），可直接展示给销售'),
      ('FollowUpTask','attempt','第几次跟进：幂等键，单调递增，永不重置'),
      ('FollowUpTask','suggestionId','这次跟进生成出来的 AI 建议'),
      ('FollowUpTask','createdAt','创建时间'),
      ('FollowUpTask','updatedAt','更新时间')
    ) AS t(tbl, col, cmt)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col
    ) THEN
      EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', r.tbl, r.col, r.cmt);
    END IF;
  END LOOP;
END $$;
