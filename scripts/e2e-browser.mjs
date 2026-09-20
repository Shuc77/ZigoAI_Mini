#!/usr/bin/env node
/**
 * 真实浏览器端到端测试（Playwright + 本机已安装的 Edge/Chrome）。
 *
 * 为什么必须有它：
 *   `scripts/smoke.mjs` 用 Node 发 HTTP 请求，**不执行任何浏览器 JavaScript**。
 *   因此它对"客户端才能暴露的问题"完全失明 —— 本次上线就连续漏掉两个：
 *     ① 会话 Cookie 带了 `Secure`，HTTP 站点下浏览器直接丢弃 → 登录页死循环
 *        （Node 不在乎 Secure 标记，照样保存并回传，所以断言全绿）
 *     ② `crypto.randomUUID()` 在非安全上下文（http://IP）不可用 → 点发送抛
 *        TypeError，按钮像"点了没反应"
 *   这两个都只在真实浏览器里复现，只有真实浏览器能挡住它们。
 *
 * 覆盖范围：登录 → 客户列表 → 客户详情 → 录入客户消息 → 等待 AI 判断卡片
 *          → 编辑建议回复 → 销售发送 → 断言消息进入聊天记录，
 *          全程收集 pageerror / console.error / 请求失败。
 *
 * 用法：
 *   node scripts/e2e-browser.mjs                            # 默认 http://127.0.0.1:8083
 *   node scripts/e2e-browser.mjs http://42.194.164.30:8080  # 对线上跑
 *   BROWSER_CHANNEL=chrome node scripts/e2e-browser.mjs     # 换用 Chrome
 */
import { chromium } from 'playwright';

const baseUrl = (process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8083').replace(/\/$/, '');
const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
const PASSWORD = 'Zigo@2026';

let passed = 0;
let failed = 0;
const ok = (name, detail = '') => {
  passed += 1;
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, detail = '') => {
  failed += 1;
  console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
};

/** favicon / touch icon 的 404、以及 Next 路由预取的主动取消，都是噪音，不算功能错误 */
const isNoise = (text) =>
  /favicon|apple-touch-icon|manifest\.json/i.test(text) ||
  (/ERR_ABORTED/.test(text) && /_rsc=/.test(text));

console.log(`\n[e2e] 浏览器：${channel} | 目标：${baseUrl}\n`);

const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const clientErrors = [];
const httpErrors = [];
page.on('pageerror', (error) => clientErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error' && !isNoise(message.text())) {
    clientErrors.push(`console.error: ${message.text()}`);
  }
});
page.on('requestfailed', (request) => {
  const text = `${request.url()} ${request.failure()?.errorText ?? ''}`;
  if (!isNoise(text)) clientErrors.push(`requestfailed: ${text}`);
});
/** 按 URL 记录 4xx/5xx，便于精确定位（console 里的 404 文本不带 URL，无法区分是否为 favicon） */
page.on('response', (response) => {
  if (response.status() >= 400 && !isNoise(response.url())) {
    httpErrors.push(`${response.status()} ${response.url()}`);
  }
});

/**
 * 等待某个 POST 完成并返回状态码。
 * 为什么不能"点完按钮就等页面出现文字"：Playwright 的文本匹配会把输入框里的值也算作可见文本，
 * 于是断言会立刻通过，测试抢在请求完成前就进入下一步 —— 本次就因此把在飞的 POST 用 reload 打断了。
 */
async function clickAndAwaitPost(testId, urlPart) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(urlPart) && r.request().method() === 'POST',
      { timeout: 60_000 },
    ),
    page.getByTestId(testId).click(),
  ]);
  return response;
}

const marker = `浏览器E2E-${Date.now()}`;

try {
  // ---- 1. 登录（曾经因为 Secure Cookie 在这里卡死） ----
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  ok('未登录时跳转到登录页');

  await page.locator('button', { hasText: 'sales@lemeng.demo' }).first().click();
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/customers/, { timeout: 25_000 });
  ok('登录成功并进入客户列表', page.url().replace(baseUrl, ''));

  // ---- 2. 进入客户详情 ----
  await page.locator('table tbody tr').first().locator('a').first().click();
  await page.waitForURL(/\/customers\/[A-Za-z0-9]+/, { timeout: 25_000 });
  await page.waitForSelector('textarea', { timeout: 20_000 });
  ok('进入客户详情页并加载聊天记录');

  // ---- 3. 录入客户消息（曾经因为 crypto.randomUUID 在这里抛异常） ----
  await page.getByTestId('customer-composer').fill(`${marker}：你们年卡多少钱？`);
  const messageResponse = await clickAndAwaitPost('customer-send', '/messages');
  if (messageResponse.status() === 201) {
    ok('客户消息提交成功', 'HTTP 201');
  } else {
    fail('客户消息提交失败', `HTTP ${messageResponse.status()}`);
  }

  const chat = page.getByTestId('chat-messages');
  await chat.getByText(`${marker}：你们年卡多少钱？`).waitFor({ timeout: 30_000 });
  ok('客户消息已出现在聊天记录');

  // ---- 4. 等待 AI 判断卡片（真实调用 DeepSeek） ----
  await page.waitForSelector('text=建议回复', { timeout: 90_000 });
  const intentText = await page.locator('text=客户意图').first().isVisible();
  ok('AI 判断卡片已渲染', intentText ? '含客户意图 / 阶段 / 下一步动作' : '');

  // ---- 5. 销售编辑并发送建议回复 ----
  const sentText = `${marker}：销售回复`;
  await page.getByTestId('suggestion-reply').fill(sentText);
  const sendResponse = await clickAndAwaitPost('suggestion-send', '/send');
  if (sendResponse.status() === 201) {
    ok('销售发送请求成功', 'HTTP 201');
  } else {
    fail('销售发送请求失败', `HTTP ${sendResponse.status()}`);
  }

  // 断言限定在聊天记录区域内，避免匹配到输入框自身的值
  await chat.getByText(sentText).waitFor({ timeout: 30_000 });
  ok('销售回复已进入聊天记录');

  // ---- 6. 刷新后数据仍在（持久化） ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-messages').getByText(sentText).waitFor({ timeout: 30_000 });
  ok('刷新页面后数据仍在（已持久化）');

  // ---- 7. 客户端零异常 ----
  if (httpErrors.length === 0) {
    ok('无 4xx / 5xx 请求', '静态资源与接口全部正常');
  } else {
    fail('存在失败请求', httpErrors.slice(0, 5).join(' | '));
  }

  if (clientErrors.length === 0) {
    ok('全程无客户端异常', '无 pageerror / console.error / 请求失败');
  } else {
    fail('客户端出现异常', clientErrors.slice(0, 5).join(' | '));
  }
} catch (error) {
  fail('流程中断', String(error.message ?? error).split('\n')[0]);
  const shot = 'e2e-failure.png';
  try {
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`    失败截图已保存：${shot}（可直接打开查看当时页面状态）`);
  } catch {
    /* 截图失败不影响结论 */
  }
  if (clientErrors.length > 0) {
    console.log('    捕获到的客户端异常：');
    for (const line of clientErrors.slice(0, 5)) console.log(`      - ${line}`);
  }
} finally {
  await browser.close();
}

console.log(`\n[e2e] 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
