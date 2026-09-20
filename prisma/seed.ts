import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '@/lib/auth/password';
import { prisma } from '@/lib/db';
import type { LeadStage } from '@/generated/prisma/enums';

/**
 * 演示种子数据。
 *
 * 设计原则：
 * 1) **幂等**：先按 slug 删除两个演示租户（级联清空其客户/消息/状态），再重建。
 *    反复执行不会产生重复数据。
 * 2) **可演示**：每个租户都包含三种典型客户 —— 高意向、静默待跟进、投诉待人工介入，
 *    这样 Demo 时不用现场造数据就能覆盖全部核心链路。
 * 3) **规则取自题目原文**：乐蒙"未表达兴趣前不主动报价"、机械之家"确认设备与保险需求后优先索取行驶证"。
 */

const DEMO_PASSWORD = 'Zigo@2026';

type SeedMessage = {
  role: 'CUSTOMER' | 'SALES';
  content: string;
  minutesAgo: number;
  /** SALES 消息记录发送人（用种子里的销售账号） */
  bySales?: boolean;
};

type SeedCustomer = {
  name: string;
  handle: string;
  phone?: string;
  source?: string;
  note?: string;
  state: {
    leadStage: LeadStage;
    intent: string;
    needHuman: boolean;
    humanReason?: string;
    followUpCount?: number;
  };
  messages: SeedMessage[];
};

type SeedTenant = {
  slug: string;
  name: string;
  salesGoal: string;
  tone: string;
  rules: Array<{ id: string; text: string; guard?: string }>;
  forbidden: string[];
  /**
   * 交接规则：不同企业的转人工标准不同，这正是"同一句话、两家企业、判断不同"的来源之一。
   * 乐蒙（低客单体验课）只要金额不大就交给 AI 跟；机械之家（高客单设备保险）涉及保费就人工核保。
   */
  handoff: {
    keywords: string[];
    amountThreshold: number | null;
    note: string;
  };
  users: Array<{ email: string; name: string; role: 'SALES' | 'MANAGER' }>;
  salesEmail: string;
  customers: SeedCustomer[];
};

const TENANTS: SeedTenant[] = [
  {
    slug: 'lemeng',
    name: '乐蒙亲子游泳',
    salesGoal: '推动客户预约线下体验课',
    tone: '亲切、口语化，每句话不超过 60 字',
    rules: [
      {
        id: 'R1',
        text: '客户尚未表达明确兴趣前，不主动报价，也不主动提优惠',
        guard: 'FORBID_QUOTE_BEFORE_INTEREST',
      },
      { id: 'R2', text: '优先推动预约到店体验课，并主动给出 2 个可选时间段' },
      { id: 'R3', text: '涉及孩子年龄、泳池水质、教练资质的问题要正面回答，不夸大效果' },
      {
        id: 'R4',
        text: '不得使用"保证学会""一定有效"这类绝对化承诺',
        guard: 'FORBID_ABSOLUTE_PROMISE',
      },
    ],
    forbidden: ['承诺具体折扣或免单', '承诺孩子一定学会游泳', '承诺医疗或健康效果'],
    handoff: {
      keywords: ['退费', '投诉到总部', '曝光', '媒体'],
      amountThreshold: 5000,
      note: '体验课与常规课包可由 AI 直接跟进；年卡及以上（金额达到 5000 元）务必人工确认',
    },
    users: [
      { email: 'manager@lemeng.demo', name: '王敏（销售主管）', role: 'MANAGER' },
      { email: 'sales@lemeng.demo', name: '李婷（课程顾问）', role: 'SALES' },
    ],
    salesEmail: 'sales@lemeng.demo',
    customers: [
      {
        name: '张女士',
        handle: 'zhang_nvshi',
        phone: '138****2210',
        source: '朋友圈广告',
        note: '孩子 5 岁半，怕水',
        state: { leadStage: 'INTERESTED', intent: '询价', needHuman: false },
        messages: [
          { role: 'CUSTOMER', content: '你好，你们这边是教小孩游泳的吗？', minutesAgo: 48 },
          { role: 'SALES', content: '是的～我们专注 3-12 岁儿童游泳启蒙，请问孩子多大了？', minutesAgo: 46, bySales: true },
          { role: 'CUSTOMER', content: '5 岁半，有点怕水', minutesAgo: 45 },
          { role: 'SALES', content: '5 岁半正是学游泳的好时候，怕水我们有专门的适应课，先让孩子熟悉水性', minutesAgo: 43, bySales: true },
          { role: 'CUSTOMER', content: '一节课多少钱？有体验课吗？', minutesAgo: 2 },
        ],
      },
      {
        name: '刘先生',
        handle: 'liu_xiansheng',
        phone: '139****7788',
        source: '门店到访',
        note: '孩子 7 岁，问了周末班后失去回复',
        state: { leadStage: 'DISCOVERY', intent: '了解产品', needHuman: false, followUpCount: 0 },
        messages: [
          { role: 'CUSTOMER', content: '你们周末有班吗？孩子 7 岁', minutesAgo: 40 },
          { role: 'SALES', content: '有的，周末上午 10 点和下午 4 点各有一节，看您哪个时间方便？', minutesAgo: 38, bySales: true },
          { role: 'CUSTOMER', content: '我先看看时间安排', minutesAgo: 35 },
        ],
      },
      {
        name: '陈女士',
        handle: 'chen_nvshi',
        phone: '137****3344',
        source: '老客户转介绍',
        note: '体验课被临时取消，情绪较大',
        state: { leadStage: 'INTERESTED', intent: '投诉', needHuman: true, humanReason: '客户投诉' },
        messages: [
          { role: 'CUSTOMER', content: '上周约好的体验课被你们临时取消了', minutesAgo: 8 },
          { role: 'CUSTOMER', content: '孩子期待了一周，现在很失望，你们打算怎么处理？', minutesAgo: 5 },
        ],
      },
    ],
  },
  {
    slug: 'jixie',
    name: '机械之家',
    salesGoal: '获取客户车辆资料（行驶证），完成设备与保险方案报价',
    tone: '专业、简洁，术语准确，每句话不超过 60 字',
    rules: [
      {
        id: 'R1',
        text: '确认客户存在设备与保险需求后，优先索取行驶证照片',
        guard: 'REQUIRE_DOC_REQUEST_ON_DEVICE_INTENT',
      },
      { id: 'R2', text: '先确认设备型号与吨位，再谈保费区间，不报没有依据的价格' },
      { id: 'R3', text: '涉及理赔流程的问题要给出步骤，并说明需人工核保确认' },
      {
        id: 'R4',
        text: '不得承诺一定承保，也不得承诺具体理赔金额',
        guard: 'FORBID_ABSOLUTE_PROMISE',
      },
    ],
    forbidden: ['承诺一定承保', '承诺最低价', '承诺理赔金额'],
    handoff: {
      keywords: ['起诉', '律师', '监管', '曝光', '退保', '理赔纠纷'],
      amountThreshold: 1000,
      note: '凡涉及保费金额、理赔、退保的，一律人工核保，AI 不得直接承诺方案',
    },
    users: [
      { email: 'manager@jixie.demo', name: '赵刚（销售主管）', role: 'MANAGER' },
      { email: 'sales@jixie.demo', name: '陈浩（客户经理）', role: 'SALES' },
    ],
    salesEmail: 'sales@jixie.demo',
    customers: [
      {
        name: '王老板',
        handle: 'wang_laoban',
        phone: '136****9900',
        source: '400 电话',
        note: '20 吨挖机，佛山工地，关注第三者责任',
        state: { leadStage: 'INTERESTED', intent: '询价', needHuman: false },
        messages: [
          { role: 'CUSTOMER', content: '我有一台 20 吨的挖机，想问问保险怎么买', minutesAgo: 30 },
          { role: 'SALES', content: '20 吨挖机我们做得比较多，请问设备目前主要在哪个工地作业？', minutesAgo: 28, bySales: true },
          { role: 'CUSTOMER', content: '在佛山，主要是怕施工的时候伤到人', minutesAgo: 25 },
          { role: 'SALES', content: '明白，第三者责任这块要配足。方便发一下行驶证吗？我按吨位和车龄给方案', minutesAgo: 23, bySales: true },
          { role: 'CUSTOMER', content: '行驶证在公司，明天拍给你', minutesAgo: 1 },
        ],
      },
      {
        name: '李工',
        handle: 'li_gong',
        phone: '135****1122',
        source: '官网表单',
        note: '新咨询，询问叉车保险',
        state: { leadStage: 'NEW', intent: '了解产品', needHuman: false },
        messages: [{ role: 'CUSTOMER', content: '你们做不做叉车保险？', minutesAgo: 12 }],
      },
      {
        name: '黄总',
        handle: 'huang_zong',
        phone: '133****5566',
        source: '老客户',
        note: '已成交，演示"终态不参与自动跟进"',
        state: { leadStage: 'WON', intent: '购买', needHuman: false },
        messages: [
          { role: 'CUSTOMER', content: '保单出好了吗？', minutesAgo: 60 * 48 },
          { role: 'SALES', content: '已经出单，电子保单发您微信了，有问题随时找我', minutesAgo: 60 * 47, bySales: true },
        ],
      },
    ],
  },
];

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

async function main() {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  for (const seed of TENANTS) {
    // 幂等：删掉旧的演示租户（级联清空其下所有数据）再重建
    await prisma.tenant.deleteMany({ where: { slug: seed.slug } });

    const tenant = await prisma.tenant.create({
      data: {
        name: seed.name,
        slug: seed.slug,
        salesGoal: seed.salesGoal,
        tone: seed.tone,
        rules: seed.rules,
        forbidden: seed.forbidden,
        handoff: {
          triggers: {
            complaint: true,
            wantsHuman: true,
            aiUnsure: true,
            highValue: true,
            ruleConflict: true,
          },
          keywords: seed.handoff.keywords,
          amountThreshold: seed.handoff.amountThreshold,
          note: seed.handoff.note,
        },
      },
    });

    const userByEmail = new Map<string, string>();
    for (const user of seed.users) {
      const created = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: user.email,
          name: user.name,
          passwordHash,
          role: user.role,
        },
      });
      userByEmail.set(user.email, created.id);
    }

    const salesUserId = userByEmail.get(seed.salesEmail);
    if (!salesUserId) throw new Error(`种子数据缺少销售账号 ${seed.salesEmail}`);

    for (const customer of seed.customers) {
      const created = await prisma.customer.create({
        data: {
          tenantId: tenant.id,
          name: customer.name,
          handle: customer.handle,
          phone: customer.phone,
          source: customer.source,
          note: customer.note,
          assigneeId: salesUserId,
        },
      });

      // 消息按时间升序写入，保证详情页顺序正确
      const ordered = [...customer.messages].sort((a, b) => b.minutesAgo - a.minutesAgo);
      await prisma.message.createMany({
        data: ordered.map((message) => ({
          tenantId: tenant.id,
          customerId: created.id,
          role: message.role,
          content: message.content,
          senderUserId: message.bySales ? salesUserId : null,
          createdAt: minutesAgo(message.minutesAgo),
        })),
      });

      const lastCustomerMessage = ordered.filter((m) => m.role === 'CUSTOMER').at(-1);
      const lastAnyMessage = ordered.at(-1);

      await prisma.customerState.create({
        data: {
          tenantId: tenant.id,
          customerId: created.id,
          leadStage: customer.state.leadStage,
          intent: customer.state.intent,
          needHuman: customer.state.needHuman,
          humanReason: customer.state.humanReason,
          followUpCount: customer.state.followUpCount ?? 0,
          lastContactAt: lastAnyMessage ? minutesAgo(lastAnyMessage.minutesAgo) : null,
          lastCustomerMessageAt: lastCustomerMessage ? minutesAgo(lastCustomerMessage.minutesAgo) : null,
        },
      });
    }

    console.log(`[seed] ${seed.name}：${seed.customers.length} 个客户、${seed.users.length} 个账号`);
  }

  const [tenants, users, customers, messages] = await Promise.all([
    prisma.tenant.count(),
    prisma.user.count(),
    prisma.customer.count(),
    prisma.message.count(),
  ]);

  console.log('');
  console.log('[seed] 完成 —— 登录账号（密码统一 ' + DEMO_PASSWORD + '）：');
  for (const seed of TENANTS) {
    for (const user of seed.users) {
      const label = user.role === 'MANAGER' ? '主管' : '销售';
      console.log(`  ${seed.name.padEnd(8, '　')} ${label}  ${user.email}`);
    }
  }
  console.log('');
  console.log(`[seed] 数据统计：租户 ${tenants}、用户 ${users}、客户 ${customers}、消息 ${messages}`);
  console.log(`[seed] runId=${randomUUID().slice(0, 8)}`);
}

main()
  .catch((error) => {
    console.error('[seed] 失败：', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
