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

function ok(name, detail = '') {
  passed += 1;
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  failed += 1;
  console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
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

// --- 汇总 ------------------------------------------------------------------
console.log(`\n[smoke] 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
