#!/usr/bin/env node
/**
 * 端到端冒烟检查（本地开发与线上部署共用同一个脚本）
 *
 * 用法：
 *   node scripts/smoke.mjs                             # 默认检查 http://127.0.0.1:3000
 *   node scripts/smoke.mjs http://42.194.164.30:8080   # 检查线上地址
 *   node scripts/smoke.mjs http://127.0.0.1:3000 --deepseek   # 额外做一次真实 AI 调用
 *
 * 它检查的是"业务不变量"，而不只是"接口返回 200"：
 *   1. 健康检查（进程 + 数据库，可选真实 AI 调用）
 *   2. 错误密码必须被拒绝
 *   3. 四个演示账号都能登录
 *   4. **租户隔离**：乐蒙的销售看不到机械之家的客户，反之亦然
 *   5. **角色作用域**：销售只看自己名下客户，主管看本企业全部
 *   6. 未登录访问业务页必须被重定向到登录页
 */
const args = process.argv.slice(2);
const baseUrl = (args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const checkDeepSeek = args.includes('--deepseek');

const PASSWORD = 'Zigo@2026';
let passed = 0;
let failed = 0;
/** 跨小节共享的上下文（客户 id、最新建议 id） */
const shared = { customerId: null, suggestionId: null };

function ok(name, detail = '') {
  passed += 1;
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  failed += 1;
  console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
}

/** React 会在 SSR 输出里转义这些字符，比对页面文本时需要同样处理 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

async function login(email) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { status: response.status, cookie, body: await response.json().catch(() => null) };
}

async function getCustomersPage(cookie) {
  const response = await fetch(`${baseUrl}/customers`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  return { status: response.status, location: response.headers.get('location'), html: await response.text() };
}

console.log(`\n[smoke] 目标：${baseUrl}${checkDeepSeek ? '（含真实 AI 调用）' : ''}\n`);

// --- 1. 健康检查 -----------------------------------------------------------
console.log('健康检查');
try {
  const response = await fetch(`${baseUrl}/api/health`);
  const data = await response.json();
  if (response.ok && data.ok && data.checks?.database?.ok) {
    ok('服务与数据库正常', `db ${data.checks.database.latencyMs}ms, 模型 ${data.model}`);
  } else {
    fail('服务或数据库异常', JSON.stringify(data.checks ?? data));
  }
} catch (error) {
  fail('无法访问 /api/health', error.message);
}

if (checkDeepSeek) {
  try {
    const response = await fetch(`${baseUrl}/api/health?deepseek=1`);
    const data = await response.json();
    const llm = data.checks?.deepseek;
    if (llm?.ok) {
      ok('DeepSeek 真实调用成功', `${llm.model} ${llm.latencyMs}ms, tokens ${llm.tokens?.promptTokens}+${llm.tokens?.completionTokens}`);
    } else {
      fail('DeepSeek 调用失败', `${llm?.errorKind ?? ''} ${llm?.errorMessage ?? ''}`);
    }
  } catch (error) {
    fail('DeepSeek 检查异常', error.message);
  }
}

// --- 2. 认证 ---------------------------------------------------------------
console.log('\n认证');
{
  const bad = await login('sales@lemeng.demo');
  const wrongPassword = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sales@lemeng.demo', password: 'wrong-password' }),
  });
  if (wrongPassword.status === 401) ok('错误密码被拒绝', 'HTTP 401');
  else fail('错误密码未被拒绝', `HTTP ${wrongPassword.status}`);
  if (bad.status === 200 && bad.cookie) ok('正确密码可登录', bad.body?.user?.tenant);
  else fail('正确密码登录失败', `HTTP ${bad.status}`);
}

{
  const anonymous = await getCustomersPage('');
  if (anonymous.status >= 300 && anonymous.status < 400 && anonymous.location?.includes('/login')) {
    ok('未登录访问业务页被重定向', `HTTP ${anonymous.status} → ${anonymous.location}`);
  } else {
    fail('未登录访问业务页未被拦截', `HTTP ${anonymous.status}`);
  }
}

// --- 3. 租户隔离与角色作用域 ------------------------------------------------
console.log('\n租户隔离与角色作用域');
const sessions = {};
for (const email of ['sales@lemeng.demo', 'manager@lemeng.demo', 'sales@jixie.demo', 'manager@jixie.demo']) {
  const result = await login(email);
  if (result.status === 200 && result.cookie) sessions[email] = result.cookie;
  else fail(`登录 ${email}`, `HTTP ${result.status}`);
}

const LEMENG = ['张女士', '刘先生', '陈女士'];
const JIXIE = ['王老板', '李工', '黄总'];

async function expectVisible(email, visible, hidden) {
  const cookie = sessions[email];
  if (!cookie) return fail(`${email} 无会话`);
  const page = await getCustomersPage(cookie);
  if (page.status !== 200) return fail(`${email} 客户列表`, `HTTP ${page.status}`);

  const missing = visible.filter((name) => !page.html.includes(name));
  const leaked = hidden.filter((name) => page.html.includes(name));

  if (missing.length === 0 && leaked.length === 0) {
    ok(`${email} 可见范围正确`, `看到 ${visible.join('、')}`);
  } else {
    fail(
      `${email} 可见范围不正确`,
      `${missing.length ? `缺少 ${missing.join('、')}；` : ''}${leaked.length ? `越权泄露 ${leaked.join('、')}` : ''}`,
    );
  }
}

await expectVisible('sales@lemeng.demo', LEMENG, JIXIE);
await expectVisible('sales@jixie.demo', JIXIE, LEMENG);
await expectVisible('manager@lemeng.demo', LEMENG, JIXIE);

// --- 4. 核心任务 1：客户与聊天记录 ------------------------------------------
console.log('\n核心任务 1 · 客户与聊天记录');
{
  const cookie = sessions['sales@lemeng.demo'];
  const foreignCookie = sessions['sales@jixie.demo'];
  const SMOKE_HANDLE = 'smoke_test_handle';

  // 幂等：已存在就复用，避免每次冒烟都堆一个新客户
  const listResponse = await fetch(`${baseUrl}/api/customers`, { headers: { cookie } });
  const list = await listResponse.json();
  let target = (list.customers ?? []).find((c) => c.handle === SMOKE_HANDLE);

  if (!target) {
    const created = await fetch(`${baseUrl}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: '冒烟测试客户',
        handle: SMOKE_HANDLE,
        source: 'scripts/smoke.mjs',
        note: '由自动化冒烟脚本创建，可安全删除',
      }),
    });
    if (created.status === 201) {
      const body = await created.json();
      target = body.customer;
      ok('创建客户成功', `HTTP 201 · ${target.name}`);
    } else {
      fail('创建客户失败', `HTTP ${created.status}`);
    }
  } else {
    ok('复用已有冒烟测试客户', target.name);
  }

  if (target) {
    const detail = await fetch(`${baseUrl}/customers/${target.id}`, { headers: { cookie } });
    const html = await detail.text();
    if (detail.status === 200 && html.includes('Customer State')) {
      ok('客户详情页可访问', `含聊天记录与状态卡片`);
    } else {
      fail('客户详情页异常', `HTTP ${detail.status}`);
    }

    const before = await fetch(`${baseUrl}/api/customers/${target.id}/messages`, {
      headers: { cookie },
    }).then((r) => r.json());
    const beforeCount = (before.messages ?? []).length;

    // 固定幂等键：第一次可能是新建(201)，也可能是历史运行留下的(200 去重)
    const clientMessageId = `smoke-fixed-${target.id}`;
    const payload = JSON.stringify({
      content: '你们周末有课吗？（冒烟测试消息）',
      clientMessageId,
    });

    const first = await fetch(`${baseUrl}/api/customers/${target.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: payload,
    });
    const firstBody = await first.json();
    if ((first.status === 201 || firstBody.deduplicated === true) && firstBody.message?.role === 'CUSTOMER') {
      ok('录入客户消息成功', `HTTP ${first.status}${firstBody.deduplicated ? '（历史数据已存在）' : ' · 已入库'}`);
    } else {
      fail('录入客户消息失败', `HTTP ${first.status} ${JSON.stringify(firstBody).slice(0, 120)}`);
    }

    // 同一条消息重复提交：必须识别为重复
    const second = await fetch(`${baseUrl}/api/customers/${target.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: payload,
    });
    const secondBody = await second.json();
    const after = await fetch(`${baseUrl}/api/customers/${target.id}/messages`, {
      headers: { cookie },
    }).then((r) => r.json());

    // 不变量：库里该 clientMessageId 的消息永远只有 1 条（与运行次数无关）
    const sameKey = (after.messages ?? []).filter((m) => m.clientMessageId === clientMessageId);
    const grew = (after.messages ?? []).length - beforeCount;

    if (secondBody.deduplicated === true && sameKey.length === 1 && grew <= 1) {
      ok('消息幂等生效', `重复提交未产生新消息（该幂等键共 ${sameKey.length} 条）`);
    } else {
      fail('消息幂等失效', `deduplicated=${secondBody.deduplicated}, 同键 ${sameKey.length} 条, 新增 ${grew} 条`);
    }

    // 跨租户访问：机械之家的账号访问乐蒙的客户必须 404
    const forbidden = await fetch(`${baseUrl}/customers/${target.id}`, { headers: { cookie: foreignCookie } });
    if (forbidden.status === 404) {
      ok('跨租户访问返回 404', '未暴露"存在但不属于你"');
    } else {
      fail('跨租户访问未被隔离', `HTTP ${forbidden.status}`);
    }

    const forbiddenApi = await fetch(`${baseUrl}/api/customers/${target.id}/messages`, {
      headers: { cookie: foreignCookie },
    });
    if (forbiddenApi.status === 404) {
      ok('跨租户 API 访问返回 404');
    } else {
      fail('跨租户 API 未被隔离', `HTTP ${forbiddenApi.status}`);
    }
  }
}

// --- 5. 核心任务 2/3：AI 判断与 Customer State -------------------------------
console.log('\n核心任务 2/3 · AI 判断与 Customer State');
{
  const cookie = sessions['sales@lemeng.demo'];
  const list = await fetch(`${baseUrl}/api/customers`, { headers: { cookie } }).then((r) => r.json());
  const target = (list.customers ?? []).find((c) => c.handle === 'smoke_test_handle');

  if (!target) {
    fail('缺少冒烟测试客户，无法验证 AI 判断');
  } else {
    const versionBefore = target.state?.version ?? 0;

    const response = await fetch(`${baseUrl}/api/customers/${target.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        content: '你们太让我失望了，约好的体验课教练临时换人也不通知，我要投诉！',
        clientMessageId: `smoke-ai-${Date.now()}`,
      }),
    });
    const body = await response.json();
    const suggestion = body.suggestion;

    if (response.status === 201 && suggestion) {
      ok('AI 返回结构化判断', `${suggestion.customerIntent} / ${suggestion.leadStage} / ${suggestion.nextAction}`);
    } else {
      fail('AI 未返回结构化判断', `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`);
    }

    if (suggestion) {
      shared.suggestionId = suggestion.id;
      shared.customerId = target.id;
      const required = [
        'customerIntent',
        'leadStage',
        'nextAction',
        'reply',
        'reason',
        'needHuman',
      ];
      const missing = required.filter((key) => suggestion[key] === undefined || suggestion[key] === null);
      if (missing.length === 0 && suggestion.reply.length > 0) {
        ok('六个必需字段齐全', `reply 长度 ${suggestion.reply.length}`);
      } else {
        fail('必需字段缺失', missing.join('、'));
      }

      // 审计完整性：原始请求/响应/耗时/token 都必须留痕，否则线上排障只能靠猜
      const audited =
        suggestion.rawRequest !== null &&
        suggestion.rawResponse !== null &&
        suggestion.latencyMs !== null &&
        suggestion.promptTokens !== null &&
        suggestion.promptVersion;
      if (audited) {
        ok('AI 调用审计字段完整', `${suggestion.model} ${suggestion.latencyMs}ms, tokens ${suggestion.promptTokens}+${suggestion.completionTokens}`);
      } else {
        fail('AI 调用审计字段不完整', JSON.stringify({ latencyMs: suggestion.latencyMs, tokens: suggestion.promptTokens }));
      }

      // 投诉场景必须触发人工介入（题目要求"至少自行设计一种触发人工介入的场景"）
      if (suggestion.needHuman === true) {
        ok('投诉场景触发人工介入', `原因：${suggestion.humanReason ?? '未说明'}`);
      } else {
        fail('投诉场景未触发人工介入', `needHuman=${suggestion.needHuman}`);
      }

      const versionAfter = body.state?.after?.version ?? versionBefore;
      if (versionAfter === versionBefore + 1) {
        ok('Customer State 版本推进', `v${versionBefore} → v${versionAfter}`);
      } else {
        fail('Customer State 版本未推进', `v${versionBefore} → v${versionAfter}`);
      }

      // 页面上确实渲染出了判断卡片（含建议回复与规则区）
      const detail = await fetch(`${baseUrl}/customers/${target.id}`, { headers: { cookie } });
      const html = await detail.text();
      const rendered =
        html.includes('AI 判断') &&
        html.includes('下一步动作') &&
        html.includes('判断依据') &&
        html.includes(escapeHtml(suggestion.reply).slice(0, 12));
      if (rendered) {
        ok('判断卡片已在客户详情页渲染', '含意图/阶段/动作/依据/建议回复');
      } else {
        fail('判断卡片未正确渲染');
      }
    }
  }
}

// --- 6. 核心任务 4：销售回复 + 人工边界 --------------------------------------
console.log('\n核心任务 4 · 销售回复与人工操作');
{
  const cookie = sessions['sales@lemeng.demo'];
  const customerId = shared.customerId;
  const suggestionId = shared.suggestionId;

  if (!customerId || !suggestionId) {
    fail('缺少上一节的上下文，跳过销售回复验证');
  } else {
    const editedReply = '非常抱歉给您带来不好的体验，我马上联系店长核实，今天下午给您回电可以吗？';

    // 1) 销售修改后发送
    const sendResponse = await fetch(`${baseUrl}/api/suggestions/${suggestionId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ reply: editedReply }),
    });
    const sendBody = await sendResponse.json();

    if (sendResponse.status === 201 && sendBody.message?.role === 'SALES') {
      ok('销售发送回复成功', `HTTP 201 · ${sendBody.edited ? '已修改 AI 建议' : '按 AI 原文'}`);
    } else {
      fail('销售发送回复失败', `HTTP ${sendResponse.status} ${JSON.stringify(sendBody).slice(0, 120)}`);
    }

    // 2) 发送内容必须进入聊天记录（按返回的消息 id 精确断言，避免"重复文本"干扰）
    const messages = await fetch(`${baseUrl}/api/customers/${customerId}/messages`, {
      headers: { cookie },
    }).then((r) => r.json());
    const sent = (messages.messages ?? []).filter((m) => m.id === sendBody.message?.id);

    if (sent.length === 1 && sent[0].role === 'SALES' && sent[0].content === editedReply) {
      ok('发送内容已进入聊天记录', '并在下一轮判断中作为历史对话被读取');
    } else {
      fail('发送内容未正确入库', `按 id 匹配到 ${sent.length} 条`);
    }

    // 3) 建议留痕：改了什么都记得住
    const detail = await fetch(`${baseUrl}/api/customers/${customerId}/messages`, { headers: { cookie } });
    if (detail.status === 200) {
      const page = await fetch(`${baseUrl}/customers/${customerId}`, { headers: { cookie } }).then((r) => r.text());
      const tracked = page.includes('销售实际发送') && page.includes(editedReply.slice(0, 12));
      if (tracked) {
        ok('建议留痕完整', '页面同时展示 AI 原文与销售实际发送内容');
      } else {
        fail('建议留痕缺失', '未看到"销售实际发送"区块');
      }
    }

    // 3.5) 核心任务 4 的关键要求：发出去的内容必须"参与下一轮 AI 判断"
    // 做法：再让客户发一条消息，然后检查这一次判断的原始请求里是否真的带上了销售刚发的那句话
    const nextRound = await fetch(`${baseUrl}/api/customers/${customerId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        content: '好的，下午三点后我在。',
        clientMessageId: `smoke-nextround-${Date.now()}`,
      }),
    });
    const nextBody = await nextRound.json();
    const rawPrompt = JSON.stringify(nextBody.suggestion?.rawRequest ?? {});
    if (nextBody.suggestion && rawPrompt.includes(editedReply)) {
      ok('销售消息参与下一轮 AI 判断', '已在下一轮 prompt 的历史对话中带上');
    } else {
      fail('销售消息未参与下一轮判断', '下一轮 prompt 里找不到销售刚发送的内容');
    }

    // 4) 重新生成：应产生一条新的建议
    const regen = await fetch(`${baseUrl}/api/suggestions/${suggestionId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ useProModel: false }),
    });
    const regenBody = await regen.json();
    if (regen.status === 200 && regenBody.suggestion?.id && regenBody.suggestion.id !== suggestionId) {
      ok('重新生成产生新建议', `${regenBody.suggestion.customerIntent} / ${regenBody.suggestion.nextAction}`);
      shared.suggestionId = regenBody.suggestion.id;
    } else {
      fail('重新生成失败', `HTTP ${regen.status}`);
    }

    // 5) 人工操作：解除"需人工"
    await fetch(`${baseUrl}/api/customers/${customerId}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'RESOLVE_HUMAN' }),
    });
    const afterResolve = await fetch(`${baseUrl}/api/customers`, { headers: { cookie } }).then((r) => r.json());
    const resolved = (afterResolve.customers ?? []).find((c) => c.id === customerId);
    if (resolved?.state?.needHuman === false) {
      ok('人工可解除"需人工"标记', '状态机上锁、人来解锁');
    } else {
      fail('解除人工标记失败', `needHuman=${resolved?.state?.needHuman}`);
    }

    // 6) 人工确认成交 → 终态
    await fetch(`${baseUrl}/api/customers/${customerId}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'CONFIRM_WON' }),
    });

    // 7) 端到端终态保护：成交后再来客户消息，AI 不得把阶段改回去
    const afterWon = await fetch(`${baseUrl}/api/customers/${customerId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        content: '算了，我再考虑考虑，先不报了。',
        clientMessageId: `smoke-terminal-${Date.now()}`,
      }),
    });
    const wonBody = await afterWon.json();
    const stageAfter = wonBody.state?.after?.leadStage ?? wonBody.state?.before?.leadStage;

    if (stageAfter === 'WON') {
      const adjustments = wonBody.adjustments ?? [];
      ok(
        '端到端终态保护生效',
        adjustments.length > 0
          ? `AI 建议被系统修正：${adjustments.map((a) => a.rule).join('、')}`
          : 'AI 未尝试改动终态',
      );
    } else {
      fail('终态被 AI 改动', `阶段变成 ${stageAfter}`);
    }

    // 8) 收尾：撤销终态，保证脚本可重复运行
    const reopen = await fetch(`${baseUrl}/api/customers/${customerId}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'REOPEN' }),
    });
    const reopenBody = await reopen.json();
    if (reopen.status === 200 && reopenBody.state?.leadStage === 'HIGH_INTENT') {
      ok('可撤销终态（重新激活）', '避免演示数据被锁死');
    } else {
      fail('撤销终态失败', `stage=${reopenBody.state?.leadStage}`);
    }
  }
}

// --- 汇总 ------------------------------------------------------------------
console.log(`\n[smoke] 通过 ${passed} 项，失败 ${failed} 项`);
if (failed === 0 && /127\.0\.0\.1|localhost/.test(baseUrl)) {
  console.log('[smoke] 提示：本脚本会在「冒烟测试客户」上累积测试消息。演示前执行 `pnpm db:seed` 可重置演示数据（该客户也会被清除）。');
}
console.log('');
process.exit(failed === 0 ? 0 : 1);
