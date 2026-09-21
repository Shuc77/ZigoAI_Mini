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
 *
 * 末尾的"重置后加载态"检查需要重置演示数据的口令（--seed-token=<口令> 或环境变量 SEED_TOKEN），
 * 未提供时自动跳过该段，其余断言照常执行。
 */
import { chromium } from 'playwright';

const baseUrl = (process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8083').replace(/\/$/, '');
const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
const PASSWORD = 'Zigo@2026';
const seedToken =
  (process.argv.find((a) => a.startsWith('--seed-token=')) ?? '').replace('--seed-token=', '') ||
  process.env.SEED_TOKEN ||
  '';

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

/**
 * 噪音过滤：
 *  - favicon / apple-touch-icon 是浏览器自动请求；
 *  - Next 路由预取被主动取消（带 _rsc= 的 ERR_ABORTED）属正常行为；
 *  - `/_next/hmr` 的 WebSocket 报错只存在于 `next dev`，生产容器里没有。
 */
const isNoise = (text) =>
  /favicon|apple-touch-icon|manifest\.json/i.test(text) ||
  (/ERR_ABORTED/.test(text) && /_rsc=/.test(text)) ||
  /_next\/hmr|WebSocket connection/i.test(text);

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

  /*
   * ---- 3.5 聚合窗口是"说完就收口"，不是固定 8 秒 ----
   * 客户这句是问句（在等答案），界面必须显示**服务端算出来的真实等待时间**（约 2 秒），
   * 而不是写死一句"约 8 秒"。这条断言守的是销售侧的体感：客户问了问题，不该让销售干等。
   */
  try {
    const notice = (await page.getByTestId('composer-notice').textContent()) ?? '';
    const seconds = Number(/(\d+)\s*秒后统一判断/.exec(notice)?.[1] ?? Number.NaN);
    if (seconds <= 3) {
      ok('问句走最短窗口（销售不必干等 8 秒）', `界面显示"约 ${seconds} 秒"｜${notice.slice(0, 40)}`);
    } else {
      fail('问句没有走快速窗口', `界面显示 ${notice}`);
    }
  } catch (error) {
    fail('未读到等待提示', String(error.message ?? error).split('\n')[0]);
  }

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

  // ---- 6. 连续消息合并：客户连发 3 条（这是最容易回归的场景） ----
  // 两个检查点：
  //   ① 输入框在等待 AI 判断期间**不能**被锁死（否则"连发"根本无法演示）
  //   ② 三条消息应被合并成一次判断
  const burst = [`连发A-${marker}`, `连发B-${marker}`, `连发C-${marker}`];
  const burstBatches = [];

  for (const text of burst) {
    await page.getByTestId('customer-composer').fill(text);
    const post = await clickAndAwaitPost('customer-send', '/messages');
    if (post.status() !== 201) {
      fail('连发消息提交失败', `HTTP ${post.status()}`);
      break;
    }
    // 输入框必须立刻回到可用状态
    const stillDisabled = await page.getByTestId('customer-composer').isDisabled();
    if (stillDisabled) {
      fail('发送后输入框被锁死，无法连发消息');
      break;
    }
    burstBatches.push(text);
  }

  if (burstBatches.length === burst.length) {
    ok('连发消息不被锁死', `连续提交 ${burst.length} 条全部成功`);
  }

  for (const text of burst) {
    await chat.getByText(text).waitFor({ timeout: 30_000 });
  }
  ok('连发的消息全部进入聊天记录');

  // 客户在连发（还没说完）→ 窗口落在中间档（约 3 秒），既不等满 8 秒也不抢答
  try {
    const notice = (await page.getByTestId('composer-notice').textContent()) ?? '';
    const seconds = Number(/(\d+)\s*秒后统一判断/.exec(notice)?.[1] ?? Number.NaN);
    if (seconds > 0 && seconds <= 5) {
      ok('连发时窗口落在中间档', `界面显示"约 ${seconds} 秒"｜${notice.slice(0, 40)}`);
    } else {
      fail('连发时的窗口不符合预期', `界面显示 ${notice}`);
    }
  } catch (error) {
    fail('未读到连发后的等待提示', String(error.message ?? error).split('\n')[0]);
  }

  try {
    await page.locator('text=合并为一次判断').first().waitFor({ timeout: 90_000 });
    ok('连发消息被合并为一次 AI 判断', '卡片上标注了合并条数');
  } catch {
    fail('未看到合并判断的标注', 'AI 卡片未出现"合并为一次判断"提示');
  }

  // ---- 7. Follow-up 演示链路（界面接线验证） ----
  try {
    const travelButton = page.locator('button', { hasText: '模拟静默 30 分钟' });
    await travelButton.scrollIntoViewIfNeeded();
    await travelButton.click();
    await page.locator('text=/已把客户最后发言时间往前拨/').waitFor({ timeout: 30_000 });
    ok('可模拟时间流逝（界面）', '跟进区块显示了模拟结果');

    const scanResponse = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/followup') && r.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      page.locator('button', { hasText: '立即扫描跟进' }).click(),
    ]).then(([response]) => response);

    if (scanResponse.status() === 200) {
      ok('跟进扫描接口可调用', 'HTTP 200');
    } else {
      fail('跟进扫描接口异常', `HTTP ${scanResponse.status()}`);
    }
  } catch (error) {
    fail('跟进区块交互失败', String(error.message ?? error).split('\n')[0]);
  }

  // ---- 8. 刷新后数据仍在（持久化） ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-messages').getByText(sentText).waitFor({ timeout: 30_000 });
  ok('刷新页面后数据仍在（已持久化）');

  // ---- 9. 客户端零异常 ----
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

  /*
   * ---- 10. 重置演示数据后的加载态（真实线上问题回归） ----
   *
   * 用户在真实环境报告的现象：重新部署/重置数据之后，客户详情页直接 404，
   * 得重新登录才行；而且新客户的 AI 判断要"刷新好几次才出来"。
   * 这三件事都必须由浏览器来判：
   *   ① 重置数据不得改变客户 id（否则已打开的 /customers/<id> 全部失效）
   *   ② 判断未落库时要给**明确的加载态**，而不是"还没有 AI 判断"
   *   ③ 判断生成后页面要**自动**出现结果，不需要人工刷新
   *
   * 放在最后：本段会重置演示数据（会删掉上面测试期间创建的客户），
   * 因此上面的"无 4xx/5xx"断言先跑完，避免把重置噪声算成缺陷。
   */
  if (seedToken) {
    const listResponse = await page.request.get(`${baseUrl}/api/customers`);
    const list = await listResponse.json();
    const demo =
      (list.customers ?? []).find((c) => c.handle === 'zhang_nvshi') ?? (list.customers ?? [])[0];

    if (demo) {
      const detailPath = `/customers/${demo.id}`;

      // 先打开一次（模拟用户此刻正开着这个页面），再重置
      await page.goto(`${baseUrl}${detailPath}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea', { timeout: 20_000 });

      const resetResponse = await page.request.post(`${baseUrl}/api/admin/reset`, {
        headers: { 'x-seed-token': seedToken },
      });
      if (resetResponse.status() === 200) {
        ok('可通过界面登录态重置演示数据', 'HTTP 200');
      } else {
        fail('重置演示数据失败', `HTTP ${resetResponse.status()}`);
      }

      // ① 用重置前的 id 重新打开同一个 URL：不得 404、不得跳登录页
      //    注意：Next 的 notFound() **不会改变 URL**，所以只比对 URL 抓不到 404，
      //    必须同时看 HTTP 状态码与页面内容（聊天区是否存在）。
      //    这一次导航同时充当"加载态"的取样点：首屏 HTML 一定还没有判断结果。
      const navResponse = await page.goto(`${baseUrl}${detailPath}`, { waitUntil: 'domcontentloaded' });
      const navStatus = navResponse?.status() ?? 0;
      const landed = page.url().replace(baseUrl, '');
      const chatVisible = await page
        .locator('[data-testid="chat-messages"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (navStatus === 200 && landed === detailPath && chatVisible) {
        ok('重置数据后旧的客户链接仍可用', 'HTTP 200 且聊天区正常（客户 id 稳定）');
      } else {
        fail(
          '重置数据后客户链接失效',
          `HTTP ${navStatus}，URL ${landed}，聊天区 ${chatVisible ? '在' : '不在'}`,
        );
      }

      // ② 判断未落库时必须有加载态
      const pendingSeen = await page
        .locator('[data-testid="judgment-pending"]')
        .first()
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

      if (pendingSeen) {
        ok('判断进行中显示加载态', '占位卡提示"正在补跑判断"，不再是"还没有 AI 判断"');
      } else {
        fail('判断进行中没有加载态', '未看到 judgment-pending 占位');
      }

      // ③ 无需任何人工刷新，结果应自动出现
      try {
        await page.locator('text=自动补跑了一次').first().waitFor({ timeout: 90_000 });
        ok('判断生成后自动出现（无需手动刷新）', '补跑结果经轮询自动渲染');
      } catch {
        fail('判断未自动出现', '等待 90 秒仍未见补跑结果');
      }

      // 措辞准确性：补跑基于历史消息，不能被说成"客户连续发送"
      const mergedLabel = await page
        .locator('text=合并为一次判断')
        .first()
        .isVisible()
        .catch(() => false);
      if (!mergedLabel) {
        ok('补跑结果不会误标为"连续发送合并"', '历史消息补跑与连发合并两种文案互斥');
      } else {
        fail('补跑结果被误标为连续发送合并', '历史消息与会话内连发是两件事');
      }

      // 冒烟后恢复干净：让演示数据回到"已判断"的可用状态
      await page.request.post(`${baseUrl}/api/admin/reset`, {
        headers: { 'x-seed-token': seedToken },
      });
    }

    /*
     * ---- 11. 历史未判断 + 刚发新消息（截图场景回归） ----
     *
     * 真实场景：演示客户的历史消息从未被判断过（种子数据直接写库），
     * 而销售刚又发了一条「我要投诉你们」。页面上同时有**两件事在跑**：
     *   ① 历史消息的补跑   ② 新消息那一轮的判断
     * 早期实现"一旦有判断就停止等待"，于是补跑先落库 → 加载态消失 →
     * 而新消息的判断还没回来 → 用户看到的卡片没反映自己刚发的消息，只能手动刷新。
     *
     * 这条断言要求：**不做任何手动刷新**，卡片最终显示的是新消息的判断（投诉 → 需人工）。
     */
    const staleList = await page.request.get(`${baseUrl}/api/customers`);
    const staleDemo = ((await staleList.json()).customers ?? []).find(
      (c) => c.handle === 'zhang_nvshi',
    );

    if (staleDemo) {
      await page.goto(`${baseUrl}/customers/${staleDemo.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea', { timeout: 20_000 });

      const stalePendingSeen = await page
        .locator('[data-testid="judgment-pending"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (stalePendingSeen) {
        ok('历史未判断时先给出加载态', '不是干巴巴的"还没有 AI 判断"');
      } else {
        fail('未看到加载态', '种子客户的历史消息未被判断，本应显示补跑提示');
      }

      await page.getByTestId('customer-composer').fill('我要投诉你们');
      const complaintSent = await clickAndAwaitPost('customer-send', '/messages');
      if (complaintSent.status() !== 201) fail('投诉消息提交失败', `HTTP ${complaintSent.status()}`);

      // 关键：全程不手动刷新，等卡片自己变
      try {
        await page.locator('text=建议人工介入').first().waitFor({ timeout: 120_000 });
        ok('新消息的判断自动出现（无需手动刷新）', '历史补跑与新消息判断两件事都完成后才收敛');
      } catch {
        fail('新消息的判断没有自动出现', '补跑先落库后加载态提前消失，用户会以为系统没反应');
      }

      const escalateText = await page
        .locator('dt', { hasText: '是否需人工' })
        .first()
        .evaluate((el) => el.parentElement?.textContent ?? '')
        .catch(() => '');
      if (escalateText.includes('是')) {
        ok('投诉被升级为人工介入（状态卡已同步）', escalateText.replace(/\s+/g, ' ').trim());
      } else {
        fail('投诉未升级为人工介入', escalateText.replace(/\s+/g, ' ').trim() || '未读到状态卡');
      }

      /*
       * ---- 12. 卡片信息架构：销售的视线里只留"发不发" ----
       * 主区域应当只有：判断结论一行 + 建议回复 + 发送按钮；
       * 依据 / 规则 / 系统修正 / 审计字段收进「为什么这么判断？」折叠区，点开仍然看得到。
       */
      const replyVisible = await page
        .locator('text=建议回复')
        .first()
        .isVisible()
        .catch(() => false);
      const sendVisible = await page.getByTestId('suggestion-send').isVisible().catch(() => false);
      if (replyVisible && sendVisible) {
        ok('卡片主区域只留结论与动作', '建议回复与发送按钮同屏可见，销售不用翻找');
      } else {
        fail('卡片主区域缺少关键动作', `建议回复 ${replyVisible ? '在' : '不在'}，发送按钮 ${sendVisible ? '在' : '不在'}`);
      }

      try {
        // 折叠区：点开后必须能看到"判断依据"
        const why = page.getByTestId('suggestion-why').first();
        await why.scrollIntoViewIfNeeded();
        await why.click();
        await page.locator('text=判断依据').first().waitFor({ timeout: 15_000 });
        ok('「为什么这么判断？」可展开', '依据 / 企业规则 / 系统修正 / 审计信息都在折叠区里');
      } catch (error) {
        fail('折叠区打不开', String(error.message ?? error).split('\n')[0]);
      }

      /* ---- 13. 判断链路详情页（③） ---- */
      try {
        const traceLink = page.locator('a', { hasText: '查看这次判断的完整链路' }).first();
        await traceLink.scrollIntoViewIfNeeded();
        const [tracePage] = await Promise.all([page.waitForEvent('popup', { timeout: 15_000 }).catch(() => null), traceLink.click()]);

        if (tracePage) {
          await tracePage.waitForLoadState('domcontentloaded');
          const traceText = (await tracePage.locator('body').textContent()) ?? '';
          const hasStages = traceText.includes('环节耗时') && traceText.includes('总耗时');
          const hasPrompt = traceText.includes('模型收到的 prompt') && traceText.includes('模型的原始输出');
          if (hasStages && hasPrompt) {
            ok('判断链路页可打开且信息完整', '分段耗时 + 送进模型的原文 + 模型原始输出');
          } else {
            fail('链路页信息不完整', `分段耗时=${hasStages}，原文=${hasPrompt}`);
          }
          await tracePage.close();
        } else {
          // 同一个标签页打开的情况
          await page.waitForLoadState('domcontentloaded');
          const text = (await page.locator('body').textContent()) ?? '';
          if (text.includes('环节耗时')) ok('判断链路页可打开', '含分段耗时');
          else fail('未进入链路页', page.url());
        }
      } catch (error) {
        fail('链路页访问失败', String(error.message ?? error).split('\n')[0]);
      }

      /* ---- 14. 待办队列（②）：列表页应当把"该处理谁"排出来 ---- */
      try {
        await page.goto(`${baseUrl}/customers`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('table tbody tr', { timeout: 20_000 });

        const needHumanCount = Number(
          ((await page.getByTestId('queue-need-human').textContent()) ?? '0').trim(),
        );
        const actionable = Number(
          ((await page.getByTestId('queue-actionable').textContent()) ?? '0').trim(),
        );
        if (needHumanCount >= 1 && actionable >= 1) {
          ok('客户列表给出待办汇总', `需要人工 ${needHumanCount} 位，待办合计 ${actionable} 位`);
        } else {
          fail('待办汇总不正确', `需要人工 ${needHumanCount}，待办 ${actionable}`);
        }

        // 刚刚投诉过的张女士必须排在第一位（优先级 0）
        const firstRow = ((await page.locator('table tbody tr').first().textContent()) ?? '').replace(/\s+/g, ' ');
        if (firstRow.includes('张女士') && firstRow.includes('需要人工')) {
          ok('需要人工的客户被排在队首', firstRow.slice(0, 60));
        } else {
          fail('待办排序没有把需人工的客户置顶', firstRow.slice(0, 80));
        }
      } catch (error) {
        fail('待办队列检查失败', String(error.message ?? error).split('\n')[0]);
      }
    }
  } else {
    console.log('  · 跳过"重置后加载态"检查（未提供 --seed-token=<口令> 或 SEED_TOKEN）');
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
