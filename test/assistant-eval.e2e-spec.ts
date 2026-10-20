import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import { HALLUCINATION_WARN } from '../src/modules/assistant/assistant.service.js';
import type { AskResult } from '../src/modules/assistant/ask.types.js';
import {
  buildExpenseContext,
  type ExpenseContext,
  type ExpenseWithItems,
} from '../src/modules/assistant/expense-context.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  LLM_PROVIDER,
  type LlmProvider,
} from '../src/modules/llm/llm.types.js';
import { asResult, parseSse } from './support/sse.js';

/**
 * 评测集。
 *
 * ── 它回答的是哪个问题 ──
 *
 * 其余测试证明的是「管道通了」：取数、组 prompt、结构化输出、流式、防幻觉。
 * 但「管道通了」和「答得对」是两件不同的事，而且后者没人能靠读代码回答。
 * 这份文件回答的是后者：**换一个模型，我怎么知道它变好了还是变差了？**
 *
 * ── 三条设计原则 ──
 *
 * 1. **断言语义，不断言措辞。** 断言的是「该不该说信息不足」「依据里有没有那个字段」
 *    「金额对不对得上数据」，不是模型的句子。措辞一定会随模型变，语义不该变。
 *    唯一的例外是 `mustMention` 里的几个关键词 —— 那是「有没有答到点上」的最低标准。
 *
 * 2. **能从数据里算出来的期望，就不手写。** 金额、明细名、驳回原因、日期全部从库里读，
 *    于是改 seed 不会让期望悄悄失效。剩下那几个手写的关键词由「预检」那条用例兜住：
 *    它先证明这些字符串真的在数据里 —— 否则用例会以一种**看起来像模型答错了**
 *    的方式失败，这种失败极难查。
 *
 * 3. **评测必须能红。** 十条全绿说明不了什么：一个永远绿的评测和没有评测是一样的。
 *    所以这里面有两条**已知会红**的用例（`knownGap`），它们红得有价值 ——
 *    说的正是「换成真模型之后必须重点盯哪两件事」。
 *    反过来，已知不足哪天不红了，用例会失败并要求把这个标记删掉，
 *    否则它会慢慢变成一张永久的免罪符。
 *
 * 4. **除了答得对不对，还要看数据是怎么来的。** 后接上工具调用之后，同一个正确答案
 *    可以来自不同的查询路径。有的路径是巧合（没查审批却答对了驳回原因），
 *    有的路径是错的（拿整单提交日回答「费用发生日」）。所以每条用例还断言
 *    **必须查过哪个工具** —— 这是「轨迹评测」，也是这一层和只看最终答案的评测
 *    最本质的区别。工具执行失败则单列为结构问题，knownGap 不豁免。
 *
 * ── 每条用例都跑两条端点 ──
 *
 * `/assistant/ask` 和 `/assistant/askStream` 各打一次，**两条都各自过一遍结构底线和语义断言**。
 * 两条跨调用的关系按 provider 分开断言：
 *
 *   · mock（规则表，确定性的）：两次调用的结果必须逐字节相等。这条抓的是
 *     「两条端点共用的 prepare/settle 漂移了」—— 只有确定性 provider 才证得了。
 *   · 真模型：**不**比两次调用的文本。实测温度 0 也不是确定的：同一请求连问三次，
 *     两次逐字相同、一次换了说法；E01 的结论一字不差，evidence 却一次一个字段、
 *     一次两个。拿两次独立采样做全等，红的是骰子，不是代码。
 *
 * 跨任何 provider 都成立的结构断言有两条：一条在流内部 —— **增量吐出的字必须等于
 * 这次流自己的 `done.conclusion`**，它不涉及第二次调用，锁的是增量解析器本身；
 * 另一条在轨迹里 —— **工具不能执行失败**。它也不涉及两次调用，锁的是工具和数据。
 * 早先这里写成了「增量 vs 非流式那次调用的结论」，在 mock 上碰巧一直成立，
 * 接真模型当天就红了 —— 而管道其实是好的。
 *
 * ── 顺带算一个幻觉率 ──
 *
 * 防幻觉那道防线（`dropUnknownEvidence`）是**剔掉**而不是报错，所以从接口返回值上
 * 看不出它拦过东西 —— 只能数它留下的 warn 日志。这就是 `HALLUCINATION_WARN`
 * 被导成常量的原因。
 *
 * ── 诚实边界（最该记住的一段）──
 *
 * 这份用例挂在**哪个 provider 上**是被测环境决定的：
 *   · `npm run eval`      → `MockLlmProvider`，一张规则表，不是模型。
 *   · `npm run eval:real` → 真厂商（`LLM_PROVIDER=openai`）。
 *
 * 跑 mock 时它证明的是「**评测本身是有效的**」：能红、能算幻觉率、能发现两条端点不一致。
 * 它**不能**证明「模型答得准」—— 那必须在真厂商上跑同一份用例。
 * 这两件事从头到尾都不是一回事，别混着说。
 *
 * 所以下面那张表**必须印出 provider 名字**：一份不说是谁答的报告，是没法两两比较的。
 */

// ─────────────────────────────────────────────────────────────
// 被测的数据：从库里读，不在测试里重写一遍
// ─────────────────────────────────────────────────────────────

interface RowData {
  code: string;
  context: ExpenseContext;
  /** 总额，形如 "3150.00" */
  amount: string;
  itemNames: string[];
  rejectReason?: string;
  status: string;
  /** UTC 日期（和模型看到的是同一个字符串） */
  submittedDate: string;
  decidedDate?: string;
  /** 明细费用发生日，含 ±1 天的换算容差 */
  spentDateVariants: string[];
}

function toRow(expense: ExpenseWithItems): RowData {
  const context = buildExpenseContext(expense);
  const spent = new Set<string>();
  for (const item of expense.items) {
    for (const date of withSlack(item.spentOn.toISOString().slice(0, 10))) {
      spent.add(date);
    }
  }

  return {
    code: expense.code,
    context,
    amount: expense.amount.toFixed(2),
    itemNames: expense.items.map((item) => item.name),
    rejectReason: expense.rejectReason ?? undefined,
    status: expense.status,
    submittedDate: expense.submittedAt.toISOString().slice(0, 10),
    decidedDate: expense.decidedAt?.toISOString().slice(0, 10),
    spentDateVariants: [...spent],
  };
}

// ─────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────

interface CaseExpectation {
  insufficient: boolean;
  /** 结论里必须出现的关键词。「有没有答到点上」的最低标准，不检查措辞。 */
  mustMention?: string[];
  evidenceIncludes?: string[];
  evidenceExcludes?: string[];
}

interface EvalCase {
  id: string;
  code: string;
  question: string;
  /** 这条在测什么 —— 会打进表里 */
  focus: string;
  expect: (row: RowData) => CaseExpectation;
  /**
   * 这个问题**必须查过**哪个工具。
   *
   * 它测的不是「答得对不对」，而是「数据是怎么来的」—— 同一个正确答案可以用不同
   * 路径拿到，但有些路径是巧合：模型答对了驳回原因，却从没查过审批记录，
   * 那只说明它蒙对了措辞。轨迹断言就是把这种蒙对挡在外面。
   *
   * 它是**语义**问题而不是结构问题，所以 knownGap 能豁免它：
   * E08 那种「用了错的工具、于是答了另一件事」的坑，正是已知不足的形状。
   * 而「工具执行失败」是结构问题，永远不豁免 —— 见 trajectoryStructuralProblems。
   */
  expectTools?: string[];
  /** 通用期望表达不了的检查，返回发现的问题（空数组 = 没问题） */
  check?: (result: AskResult, row: RowData) => string[];
  /**
   * 已知答不了，写清**是谁**答不了。
   *
   * ⚠️ 它是 provider 的属性，不是用例的属性：同一张单子 mock 会踩坑，真模型可能答对。
   * 早先这里只是一个字符串，结果在真模型上跑时那两条「已知不足」都被答对了，
   * 评测反过来要求把标记删掉 —— 可标记对 mock 仍然成立。
   * 所以必须带上 provider 名字，只在自己那个 provider 下生效。
   */
  knownGap?: { provider: string; reason: string };
}

const CASES: EvalCase[] = [
  {
    id: 'E01',
    code: 'BX-2026-0003',
    question: '这张单子为什么被驳回了？',
    focus: '能答：驳回原因',
    expectTools: ['get_approval_record'],
    expect: () => ({
      insufficient: false,
      mustMention: ['招待费超出'],
      evidenceIncludes: ['status', 'rejectReason'],
    }),
  },
  {
    id: 'E02',
    code: 'BX-2026-0009',
    question: '这张单子为什么被驳回了？',
    focus: '能答：第二条驳回单',
    expectTools: ['get_approval_record'],
    expect: () => ({
      insufficient: false,
      mustMention: ['发票抬头'],
      evidenceIncludes: ['rejectReason'],
    }),
  },
  {
    id: 'E03',
    code: 'BX-2026-0005',
    question: '审批意见是什么？',
    focus: '信息不足：草稿单没有审批',
    expectTools: ['get_approval_record'],
    expect: () => ({
      insufficient: true,
      // 数据里没有这两样，它们也就不该出现在依据里
      evidenceExcludes: ['rejectReason', 'decidedAt'],
    }),
  },
  {
    id: 'E04',
    code: 'BX-2026-0004',
    question: '审批意见是什么？',
    focus: '信息不足：待审批也没意见',
    expectTools: ['get_approval_record'],
    // 和 E03 的区别在于状态不同（SUBMITTED 而非 DRAFT）。
    // 两条一起才说明「信息不足」是按数据判的，不是按「看起来没走完」判的。
    expect: () => ({
      insufficient: true,
      evidenceExcludes: ['decidedAt'],
    }),
  },
  {
    id: 'E05',
    code: 'BX-2026-0010',
    question: '什么时候提交的？',
    focus: '能答：草稿≠全无信息',
    expectTools: ['get_expense_summary'],
    // 这条挡的是「一看到草稿就整张判成信息不足」的偷懒做法：
    // 审批信息没有，提交时间是有的，该答就得答。
    //
    // 顺带暴露 seed 的一个建模瑕疵：DRAFT 也带了 submittedAt，
    // 真系统里草稿不该有提交时间。评测的价值之一就是把这些「凑合能跑」
    // 的地方顶出来 —— 所以我留着它，没有偷偷改 seed。
    expect: (row) => ({
      insufficient: false,
      mustMention: [row.submittedDate],
      evidenceIncludes: ['submittedAt'],
    }),
  },
  {
    id: 'E06',
    code: 'BX-2026-0002',
    question: '这笔钱都花在哪些项目上？',
    focus: '能答：多明细逐条列出',
    expectTools: ['list_expense_items'],
    expect: (row) => ({
      insufficient: false,
      // 每条明细都点到名 —— 明细名从库里取，不手写。
      mustMention: row.itemNames,
      // 引用 `items[0].name` 和引用 `items` 一样有效，见 evidenceCovers。
      //
      // 这里**不**要求 `amount`：用户问的是「哪些项目」，总结金额是加分项不是必需项。
      // 原来要求它是照着 mock 的输出写的 —— mock 的那条规则里永远带一句「合计」。
      // 真模型答了三条明细、没提总额，被这条判成「依据里缺少 amount」，
      // 但那是评测在替用户加需求。
      evidenceIncludes: ['items'],
    }),
  },
  {
    id: 'E07',
    code: 'BX-2026-0001',
    question: '金额是多少？',
    focus: '金额溯源：¥3150.00',
    expectTools: ['get_expense_summary'],
    // 期望的金额从库里算，不手写 —— 手写的金额会在改 seed 后悄悄过期。
    expect: (row) => ({
      insufficient: false,
      mustMention: [row.amount],
      evidenceIncludes: ['amount'],
    }),
  },
  {
    id: 'E08',
    code: 'BX-2026-0006',
    question: '费用发生的日期是哪天？',
    focus: '陷阱：费用发生日 vs 提交日',
    // 正确答案在明细的 spentOn 上。没查明细就答日期，只能答成提交日 ——
    // 这正是这条用例要抓的坑，所以轨迹断言放在这里比语义断言更早命中。
    expectTools: ['list_expense_items'],
    knownGap: {
      provider: 'mock',
      reason:
        'mock 的「时间」规则命中的是 submittedAt，把整单提交日当成了费用发生日；' +
        '轨迹断言也把它点出来了 —— 它选的是表头工具，根本没查明细。' +
        '真实模型也很容易踩这个坑（问题是「费用发生」，答案的关键在明细的 spentOn 上）',
    },
    expect: () => ({ insufficient: false }),
    check: (result, row) => {
      const hit = row.spentDateVariants.some((date) => mentionsDate(result.conclusion, date));
      return hit
        ? []
        : [`结论里没有提到费用实际发生的日期（${row.spentDateVariants.join('、')}）`];
    },
  },
  {
    id: 'E09',
    code: 'BX-2026-0008',
    question: '这笔钱都花在哪些项目上？',
    focus: '能答：单条与多条明细',
    expectTools: ['list_expense_items'],
    expect: () => ({
      insufficient: false,
      mustMention: ['易拉宝'],
      evidenceIncludes: ['items'],
    }),
  },
  {
    id: 'E10',
    code: 'BX-2026-0007',
    question: '这笔费用的发票号是多少？',
    focus: '数据里根本没有这个维度',
    knownGap: {
      provider: 'mock',
      reason:
        'mock 没有任何规则命中，会退回「总结这张单」并声称 insufficient: false —— ' +
        '它答了另一个问题，而且不承认自己不知道。真实性（知道自己不知道）' +
        '是换成真模型之后最该盯的一条',
    },
    expect: () => ({ insufficient: true }),
  },
];

// ─────────────────────────────────────────────────────────────
// 通用检查：对每一条用例、两条端点都成立
// ─────────────────────────────────────────────────────────────

/**
 * 结构层面的问题。和「答得对不对」无关 —— 这些是**任何**回答都不该违反的底线。
 *
 * ⚠️ `evidence` 那一条看着像废话：服务端的 `dropUnknownEvidence` 已经剔过了，
 * 这里再查一遍必然通过。它存在的意义是**交叉验证** —— 哪天有人把那道防线删了
 * 或者改坏了，评测会立刻响，而不是等用户看到一段编出来的依据。
 * 「评测不采信被测代码的自述」是这个文件的基本立场。
 */
function structuralProblems(result: AskResult, context: ExpenseContext): string[] {
  const problems: string[] = [];

  if (!result.conclusion.trim()) problems.push('结论是空的');
  if (typeof result.insufficient !== 'boolean') {
    problems.push(`insufficient 不是布尔值（${typeof result.insufficient}）`);
  }

  const known = new Set(context.availableFields);
  const unknown = result.evidence.filter((field) => !known.has(field));
  if (unknown.length > 0) {
    problems.push(`依据里有数据里不存在的字段：[${unknown.join(', ')}]`);
  }

  // 金额溯源：带 ¥ 或「元」的数字，要么能在数据里找到同一个数，
  // 要么不超过这张单子的总额（模型自己算的中间和，见 MONEY_TOKEN 那段注释）。
  const amounts = knownAmounts(context.record);
  const total = Math.round(Number(context.record.amount) * 100);
  for (const cents of moneyTokens(result.conclusion)) {
    if (amounts.has(cents)) continue;
    if (Number.isFinite(total) && cents > 0 && cents <= total) continue;
    problems.push(`结论里出现了数据里没有的金额：${formatCents(cents)}`);
  }

  // 日期溯源：同上。这一条挡的是「编一个日期出来」。
  const dates = knownDates(context.record);
  for (const date of fullDateTokens(result.conclusion)) {
    if (!dates.full.has(date)) problems.push(`结论里出现了数据里没有的日期：${date}`);
  }
  for (const date of shortDateTokens(result.conclusion)) {
    if (!dates.short.has(date)) problems.push(`结论里出现了数据里没有的日期：${date}`);
  }

  return problems;
}

function semanticProblems(c: EvalCase, result: AskResult, row: RowData): string[] {
  const expected = c.expect(row);
  const problems: string[] = [];

  if (result.insufficient !== expected.insufficient) {
    problems.push(
      `insufficient 应为 ${expected.insufficient}，实际 ${result.insufficient}`,
    );
  }
  for (const token of expected.mustMention ?? []) {
    if (!result.conclusion.includes(token)) {
      problems.push(`结论里没提到「${token}」`);
    }
  }
  for (const field of expected.evidenceIncludes ?? []) {
    if (!evidenceCovers(result.evidence, field)) problems.push(`依据里缺少 ${field}`);
  }
  for (const field of expected.evidenceExcludes ?? []) {
    if (evidenceCovers(result.evidence, field)) {
      problems.push(`依据里不该有 ${field}（数据里没有这一项）`);
    }
  }

  problems.push(...(c.check?.(result, row) ?? []));
  return problems;
}

/**
 * `evidence` 里有没有「覆盖到」某个字段路径。
 *
 * 为什么不是全等：`availableFields` 是由数据**遍历**出来的（见 expense-context.ts），
 * 数组既给出 `items`，也给出 `items[0].name`。模型引用后者比引用前者**更精确**，
 * 没有理由不认。
 *
 * 实测真模型在多明细那两条用例上就是这么答的（`items[0].name`、`items[0].amount`），
 * 而评测原来只认顶层 `items` 这个字符串 —— 于是把更细的引用判成了「缺少依据」。
 * 那不是模型的问题，是断言按 mock 的写法写死了。
 */
function evidenceCovers(evidence: string[], field: string): boolean {
  return evidence.some(
    (item) =>
      item === field ||
      item.startsWith(`${field}.`) ||
      item.startsWith(`${field}[`),
  );
}

/**
 * 轨迹的**结构**问题：工具到底有没有执行成功。
 *
 * 这一条永远算失败，knownGap 不豁免 —— 模型答得好不好是一回事，
 * 工具根本跑挂了是另一回事。早先所有断言都只看最终答案，于是
 * 「工具失败了、模型照着失败信息硬答」会显示成一条正常的误解，
 * 而真正该修的是工具。
 */
function trajectoryStructuralProblems(result: AskResult): string[] {
  if (!Array.isArray(result.trace)) return ['响应里没有 trace'];

  return result.trace
    .filter((step) => !step.ok)
    .map((step) => `工具 ${step.tool} 执行失败`);
}

/**
 * 轨迹的**语义**问题：该查的查了没有。
 *
 * 只认 `ok:true` 的步骤：一个失败的工具调用不提供任何数据，
 * 把它算成「查过了」等于让防线在最该严的地方松掉。
 */
function trajectorySemanticProblems(c: EvalCase, result: AskResult): string[] {
  const expected = c.expectTools;
  if (!expected || expected.length === 0) return [];

  const called = (result.trace ?? [])
    .filter((step) => step.ok)
    .map((step) => step.tool);
  const missing = expected.filter((tool) => !called.includes(tool));
  if (missing.length === 0) return [];

  return [
    `应该查 ${missing.join('、')}，实际查的是 ${
      called.length > 0 ? [...new Set(called)].join('、') : '（一个都没查）'
    }`,
  ];
}

// ─────────────────────────────────────────────────────────────
// 金额与日期的解析
// ─────────────────────────────────────────────────────────────

/**
 * 抓结论里的钱。
 *
 * 只在两种形态上认：`¥1234.56` 和 `1234.56 元`。要求有货币符号，
 * 是为了不把「共 3 条明细」的 3、也不把日期里的数字当成金额。
 *
 * ⚠️ **这条检查在接真模型时放宽过一次**，记下来免得下一个人以为它一直是这样。
 * 原来要求每个数字都能在数据里精确找到。规则表不会做加法，所以它一直没响过；
 * 真模型会做 —— 「差旅类共 2700 元」里的 2700 数据里没有，于是被判成编造，
 * 而它其实是**推理出来的中间结果**，是好事。
 *
 * 现在认两种：**等于某个已知值**，或者**不超过这张单子的总额**。
 * 这样留下的是「不能凭空说出一个比总额还大的数」这道闸 —— 那才是编造的形状；
 * 同时允许模型做加法。
 *
 * 诚实代价：模型编一个「比较小、看起来合理」的数字是能混过去的。
 * 想更严就得把总额拆开做约束（比如「只允许明细金额的任意子集之和」），
 * 那是个子集和问题，对一个演示项目来说过度了。
 */
const MONEY_TOKEN = /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*元/g;

function moneyTokens(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(MONEY_TOKEN)) {
    const raw = (match[1] ?? match[2]).replace(/,/g, '');
    const cents = Math.round(Number(raw) * 100);
    if (Number.isFinite(cents)) out.push(cents);
  }
  return out;
}

/** 数据里出现过的金额（总额 + 每条明细），单位统一成分，避开浮点比较。 */
function knownAmounts(record: Record<string, unknown>): Set<number> {
  const out = new Set<number>();
  const add = (value: unknown) => {
    const cents = Math.round(Number(value) * 100);
    if (Number.isFinite(cents)) out.add(cents);
  };

  add(record.amount);
  for (const item of (record.items as Array<Record<string, unknown>>) ?? []) {
    add(item.amount);
  }
  return out;
}

function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

const FULL_DATE = /\d{4}-\d{2}-\d{2}/g;
const SHORT_DATE = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;

function fullDateTokens(text: string): string[] {
  return [...text.matchAll(FULL_DATE)].map((match) => match[0]);
}

/** 「3 月 30 日」→ "03-30"。模型用中文写日期时靠它兜住。 */
function shortDateTokens(text: string): string[] {
  return [...text.matchAll(SHORT_DATE)].map(
    (match) => `${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`,
  );
}

function mentionsDate(text: string, date: string): boolean {
  return text.includes(date) || shortDateTokens(text).includes(date.slice(5));
}

/**
 * 数据里出现过的日期，**允许 ±1 天的误差**。
 *
 * 为什么要这个容差：seed 里的日期是按 +08:00 写进去的（`2026-03-30T00:00:00+08:00`），
 * 取出来 `.toISOString()` 是 UTC，差 8 小时 —— 同一天会显示成前一天。
 * 我们给模型看的就是这个 UTC 字符串，它照抄没问题；但如果它「贴心地」换算成
 * 北京时间再回答，就会被误判成编造。宁可松，也不能误报。
 *
 * ⚠️ 另一处已知的松：MM-DD 不区分年份。这个项目的日期全在同一年内，所以没事；
 * 跨年了这条检查就会误报。
 */
function knownDates(record: Record<string, unknown>): {
  full: Set<string>;
  short: Set<string>;
} {
  const full = new Set<string>();
  for (const date of JSON.stringify(record).match(FULL_DATE) ?? []) {
    for (const shifted of withSlack(date)) full.add(shifted);
  }
  return { full, short: new Set([...full].map((date) => date.slice(5))) };
}

/** 一个日期，前后各加一天。 */
function withSlack(date: string): string[] {
  const base = Date.parse(`${date}T00:00:00Z`);
  return [-1, 0, 1].map((offset) =>
    new Date(base + offset * 86_400_000).toISOString().slice(0, 10),
  );
}

// ─────────────────────────────────────────────────────────────
// 跑起来
// ─────────────────────────────────────────────────────────────

interface CaseResult {
  id: string;
  code: string;
  focus: string;
  verdict: 'pass' | 'known-gap' | 'fail';
  /** 结论答得对不对（已知不足豁免的就是这一类） */
  problems: string[];
  /** 结构底线：依据里有没有编的字段、端点有没有漂移（永远不豁免） */
  structural: string[];
  knownGap?: string;
  /** 增量吐出的字数 / 最终结论字数 */
  chars: [number, number];
  /** 这次实际调用过的工具名（按调用顺序，可能重复） */
  tools: string[];
  hallucinated: boolean;
}

describe('评测集 (e2e)', () => {
  let app: NestExpressApplication | undefined;
  let rows: Map<string, RowData>;
  const results: CaseResult[] = [];
  const warnMessages: string[] = [];
  let warnSpy: MockInstance | undefined;
  /** 这一轮是谁在答。印在报告里 —— 没有它，两份报告没法比。 */
  let providerName = '';
  /**
   * 这个 provider 的输出是不是**逐字节可复现**的。
   * 只有确定性的 provider 才能断言「两次调用结果全等」（见文件头）。
   */
  let deterministic = false;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    await app.init();

    providerName = app.get<LlmProvider>(LLM_PROVIDER).name;
    // 规则表没有随机性，真模型有 —— 这条不是配置，是事实，所以写死在这里。
    deterministic = providerName === 'mock';

    const prisma = app.get(PrismaService);
    const expenses = await prisma.expense.findMany({
      include: { items: { orderBy: { spentOn: 'asc' } } },
    });
    rows = new Map(expenses.map((expense) => [expense.code, toRow(expense)]));

    // 数幻觉只能数日志 —— 那道防线是「剔除」不是「报错」，
    // 从返回值上看不出它拦过东西。
    //
    // 日志照常放行（不吞掉）：warn 里混着 Nest 自己的启动告警，
    // 吞掉就等于把别处的信号也一起关了。代价是输出里会多几行日志，
    // 换来的是下面那张表**另外**把幻觉相关的几条列出来。
    const original = Logger.prototype.warn.bind(Logger.prototype);
    warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown, ...rest: unknown[]) => {
        warnMessages.push(String(message));
        original(message, ...rest);
      });
  });

  afterAll(() => {
    printReport(results, warnMessages, providerName, deterministic);
    // `beforeAll` 失败时这两个都可能没建起来 —— 原来的写法会在那里再抛一个
    // `Cannot read properties of undefined`，把真正的失败盖掉。
    warnSpy?.mockRestore();
    return app?.close();
  });

  const ask = (body: object) =>
    request(app!.getHttpServer()).post('/assistant/ask').send(body);

  it('预检：期望里手写的关键词，必须先证明它真的在数据里', () => {
    // 这是整个文件里最该有的一条。`mustMention` 里的字符串是我手写的，
    // 一旦和 seed 对不上，用例会以一种「看起来像模型答错了」的方式失败 ——
    // 然后就会有人去改 prompt。先在这里炸，能省下那次误诊。
    const reason = (code: string) => rows.get(code)?.rejectReason ?? '';

    expect(reason('BX-2026-0003')).toContain('招待费超出');
    expect(reason('BX-2026-0009')).toContain('发票抬头');

    // 预检和用例必须验**同一种关系**：`mustMention` 查的是「结论里含不含这个子串」，
    // 明细名会被拼进结论，所以这里也得用包含而不是全等。
    // （第一版这里写的是全等，当场就被这条预检抓了：明细名是「易拉宝 2 个」。）
    const hasItem = (code: string, token: string) =>
      rows.get(code)?.itemNames.some((name) => name.includes(token)) ?? false;

    expect(hasItem('BX-2026-0002', '机械键盘')).toBe(true);
    expect(hasItem('BX-2026-0008', '易拉宝')).toBe(true);

    // 两条「数据里没有审批」的单子，确实没有 decidedAt
    expect(rows.get('BX-2026-0005')?.decidedDate).toBeUndefined();
    expect(rows.get('BX-2026-0004')?.decidedDate).toBeUndefined();

    // 陷阱用例的前提：费用发生在 3 月，提交在 4 月，两者不能是同一天
    const trap = rows.get('BX-2026-0006');
    expect(trap?.submittedDate.startsWith('2026-04')).toBe(true);
    expect(trap?.spentDateVariants.some((d) => d.startsWith('2026-03'))).toBe(true);
  });

  it.each(CASES)('$id｜$code｜$focus', async (c) => {
    const row = rows.get(c.code);
    expect(row, `库里没有 ${c.code} —— 先跑 npm run db:seed`).toBeDefined();

    const body = { code: c.code, question: c.question };
    const warnedBefore = warnMessages.length;

    // ── 非流式 ──
    const awaited = (await ask(body).expect(200)).body as AskResult;

    // ── 流式 ──
    const streamedBody = (
      await request(app!.getHttpServer()).post('/assistant/askStream').send(body).expect(200)
    ).text;
    const frames = parseSse(streamedBody);
    const done = frames.find((frame) => frame.event === 'done');
    const deltas = frames
      .filter((frame) => frame.event === 'delta')
      .map((frame) => frame.data.text as string);
    const viaStream = done ? asResult(done) : undefined;

    // 两类问题分开记，因为它们的「可豁免性」不同：
    //   · 结构底线（依据里有编的字段、端点漂移、增量对不上）——**永远算失败**。
    //     这些不是「模型答得不好」，是管道坏了。
    //   · 结论的语义（该不该说信息不足、答没答到点上）—— knownGap 豁免的就是这一类。
    //
    // 分开这件事是变异测试逼出来的：把 `dropUnknownEvidence` 拆掉之后，
    // 两条 knownGap 用例照样显示「已知不足」，而它们其实已经在编字段了 ——
    // 一个标记把管道故障一起盖住了。
    const structural = [
      ...structuralProblems(awaited, row!.context),
      ...trajectoryStructuralProblems(awaited),
    ];
    const problems = [
      ...semanticProblems(c, awaited, row!),
      ...trajectorySemanticProblems(c, awaited),
    ];

    if (!done || !viaStream) {
      structural.push(
        `流式端点没有给出 done 帧（收到的事件：${frames.map((f) => f.event).join(', ')}）`,
      );
    } else {
      // 流式这条端点**自己**也要过一遍结构底线和语义断言。
      // 只拿它和非流式比全等的话，在真模型上什么也比不出来（见文件头）。
      structural.push(
        ...structuralProblems(viaStream, row!.context).map((p) => `流式端点：${p}`),
        ...trajectoryStructuralProblems(viaStream).map((p) => `流式端点：${p}`),
      );
      for (const problem of semanticProblems(c, viaStream, row!)) {
        // 同一个问题两条端点上都有时只说一次；只有流式那条坏掉时标出来。
        if (!problems.includes(problem)) problems.push(`流式端点：${problem}`);
      }
      for (const problem of trajectorySemanticProblems(c, viaStream)) {
        if (!problems.includes(problem)) problems.push(`流式端点：${problem}`);
      }

      // 两条端点共用一个 prepare() 和一套收口。这条抓的是「它们漂移了」——
      // 但只有确定性 provider 才证得了：真模型下这是两次独立采样，
      // 全等断言红的是骰子。真模型那一路的等价保证由上面的「各自过一遍」承担。
      if (deterministic && JSON.stringify(viaStream) !== JSON.stringify(awaited)) {
        structural.push('流式端点的结果和非流式不一致');
      }
    }

    // 增量 vs **这次流自己的**最终结论。trimEnd 是因为 parseAnswer 会对 conclusion
    // 做 trim()，差值只可能出现在末尾空白。
    const joined = deltas.join('').trimEnd();
    if (viaStream && joined !== viaStream.conclusion) {
      structural.push(
        `增量吐出的字和本次流的最终结论对不上（增量 ${joined.length} 字 / 最终 ${viaStream.conclusion.length} 字）`,
      );
    }

    const hallucinated = warnMessages
      .slice(warnedBefore)
      .some((message) => message.includes(HALLUCINATION_WARN));

    // knownGap 只在自己那个 provider 下生效 —— 已知不足是 provider 的属性。
    const gap = c.knownGap?.provider === providerName ? c.knownGap : undefined;

    const verdict =
      structural.length > 0 || (problems.length > 0 && !gap)
        ? 'fail'
        : problems.length > 0
          ? 'known-gap'
          : 'pass';

    results.push({
      id: c.id,
      code: c.code,
      focus: c.focus,
      verdict,
      problems,
      structural,
      knownGap: gap?.reason,
      chars: [joined.length, viaStream?.conclusion.length ?? 0],
      tools: awaited.trace.map((step) => step.tool),
      hallucinated,
    });

    if (gap && structural.length === 0) {
      // 已知不足哪天不红了，就是被修好了（或者被绕过去了）——
      // 两种情况都得回来看一眼，不能让它一直挂着当免罪符。
      expect(
        problems.length,
        `「${c.focus}」在 ${providerName} 上已经不红了，把这条用例的 knownGap 删掉`,
      ).toBeGreaterThan(0);
    } else {
      // 结构问题一并当成失败报出来。
      expect([...structural, ...problems]).toEqual([]);
    }
  });

  describe('防线自检：故意让模型编一个字段', () => {
    /**
     * 这两条**只在 mock 下有意义**：它们靠 `MOCK_MISBEHAVE=unknown-field` 让假模型
     * 故意多引用一个不存在的字段。真模型不认这个环境变量，所以在那一路必然红 ——
     * 而且红得没有任何信息量（防线根本没被喂到幻觉）。
     *
     * 跳过是显式的，报告里也会说「这一轮没跑」：不能让一条自检悄悄消失，
     * 否则「防线还活着」这件事就只剩 mock 那一轮的证据，却没人知道。
     */
    const requiresMock = (ctx: { skip: () => void }) => {
      if (providerName !== 'mock') ctx.skip();
    };

    it('编出来的字段会被剔除，请求本身仍然成功', async (ctx) => {
      // 这条不是在测模型，是在测**防线本身还活着**。
      // 前面十条用例全绿也可能是「防线根本没被触发过」，
      // 只有主动喂一次幻觉，才能证明它真的会拦。
      requiresMock(ctx);
      process.env.MOCK_MISBEHAVE = 'unknown-field';
      try {
        const result = (
          await ask({ code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' }).expect(200)
        ).body as AskResult;

        expect(result.evidence).not.toContain('approverSignature');
        expect(result.evidence).toContain('rejectReason');
      } finally {
        delete process.env.MOCK_MISBEHAVE;
      }
    });

    it('剔除这件事留下了日志 —— 幻觉率就是数它', (ctx) => {
      requiresMock(ctx);
      expect(
        warnMessages.some((message) => message.includes(HALLUCINATION_WARN)),
      ).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 出表
// ─────────────────────────────────────────────────────────────

/**
 * 东亚宽字符的区间。中文占两列，`padEnd` 按字符数算会错位 —— 表就会歪。
 * 这是个小事，但一张歪的表没人愿意看，而没人看的评测等于没做。
 *
 * 用转义写而不是把字符本身贴进来：那几段区间里有大量不可见字符，
 * 贴进来的话下一个人根本看不出这个正则匹配的是什么。
 */
const WIDE_CHAR =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

const VERDICT_LABEL = {
  pass: '✓',
  'known-gap': '⚠ 已知不足',
  fail: '✗ 不符预期',
} as const;

/**
 * 报告里工具名印成中文短标签。
 *
 * 工具名有 19 个字符，直接印会把表撑得很宽；而这个列要回答的问题只有
 * 「它查的是哪一块」，短标签足够。失败详情里仍然印完整工具名 ——
 * 那时需要的是能拿去 grep 的字符串。
 */
const TOOL_LABEL: Record<string, string> = {
  get_expense_summary: '表头',
  list_expense_items: '明细',
  get_approval_record: '审批',
};

function toolLabels(tools: string[]): string {
  return tools.length === 0
    ? '（未调）'
    : tools.map((tool) => TOOL_LABEL[tool] ?? tool).join('→');
}

function printReport(
  results: CaseResult[],
  warnMessages: string[],
  providerName: string,
  deterministic: boolean,
): void {
  const columns = [
    { title: '用例', width: 6 },
    { title: '单号', width: 14 },
    { title: '测什么', width: 26 },
    { title: '工具', width: 12 },
    { title: '增量/最终', width: 12 },
    { title: '判定', width: 12 },
  ];

  const rule = columns.map((c) => '─'.repeat(c.width)).join('─┼─');
  const header = columns.map((c) => pad(c.title, c.width)).join(' │ ');

  console.log(
    `\n评测结果（${results.length} 条用例，每条都跑了两条端点）　provider：${providerName}`,
  );
  console.log('工具列：表头=get_expense_summary　明细=list_expense_items　审批=get_approval_record');
  // 跑的是规则表就得说出来。同一张全绿的表，一个是「模型答得准」，
  // 另一个只是「规则表按预期执行了」—— 两者的含义差着一个量级。
  if (!deterministic) {
    console.log(
      'ℹ️ 真模型在同一请求上不是逐字确定的（温度 0 也只是降低随机性）。' +
        '所以跨端点只断言语义，不比对两次调用的文本。',
    );
    console.log('ℹ️ 防线自检本轮未运行：它靠 MOCK_MISBEHAVE 注入幻觉，只有 mock 认这个变量。');
  } else {
    console.log('⚠️ 这一轮是规则表在答，不是模型。它证明的是评测本身有效，不是模型答得准。');
  }
  console.log(header);
  console.log(rule);

  for (const r of results) {
    console.log(
      [
        pad(r.id, columns[0].width),
        pad(r.code, columns[1].width),
        pad(r.focus, columns[2].width),
        pad(toolLabels(r.tools), columns[3].width),
        pad(`${r.chars[0]} / ${r.chars[1]}`, columns[4].width),
        pad(VERDICT_LABEL[r.verdict], columns[5].width),
      ].join(' │ '),
    );
  }

  const passed = results.filter((r) => r.verdict === 'pass').length;
  const gaps = results.filter((r) => r.verdict === 'known-gap');
  const failed = results.filter((r) => r.verdict === 'fail');

  console.log(rule);
  console.log(`通过 ${passed}　已知不足 ${gaps.length}　不符预期 ${failed.length}`);
  console.log(
    `幻觉率 ${results.filter((r) => r.hallucinated).length}/${results.length}` +
      `（依据里出现数据之外的字段，被防线剔除并记了日志的用例数）`,
  );

  for (const r of [...failed, ...gaps]) {
    console.log(`\n${VERDICT_LABEL[r.verdict]}　${r.id}　${r.code}　${r.focus}`);
    // 结构问题排在前面：它比「答得不对」严重一档。
    for (const problem of r.structural) console.log(`   ✗ ${problem}　【结构底线】`);
    for (const problem of r.problems) console.log(`   · ${problem}`);
    if (r.knownGap && r.problems.length > 0) {
      console.log(`   为什么先留着：${r.knownGap}`);
    }
    if (r.knownGap && r.structural.length > 0) {
      console.log('   ⚠ 已知不足**不豁免**结构底线：上面那几条是管道的问题，得去改代码。');
    }
  }

  if (warnMessages.length > 0) {
    console.log(`\n本轮共 ${warnMessages.length} 条 warn，其中幻觉相关：`);
    for (const message of warnMessages.filter((m) => m.includes(HALLUCINATION_WARN))) {
      console.log(`   · ${message}`);
    }
  }
  console.log('');
}
