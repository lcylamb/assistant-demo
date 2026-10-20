import type { LlmToolSpec } from '../llm/llm.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  buildApprovalRecord,
  buildExpenseHeader,
  buildExpenseItems,
  fieldsOf,
} from './expense-context.js';

/**
 * 模型能用的只读工具。
 *
 * ── 为什么是「工具」，不是把数据塞进 prompt ──
 *
 * 塞进去的版本里，模型没有决策空间：数据已经在眼前，它只是把字段组织成一句话。
 * 工具版本里，**查什么由模型决定** —— 问驳回原因它该查审批记录，问明细它该查明细。
 * 这是这个 demo 从「结构化输出」走向 Agent 的那一步，也是它唯一不可被模板替代的地方。
 *
 * ── 三个工具为什么切在这三刀 ──
 *
 * 对应三种问题，也对应三块真实存在的权限/查询边界：
 *   · 表头   —— 这张单子是谁、多少钱、什么状态
 *   · 明细   —— 钱花在哪几条上（含合计，合计是明细的投影）
 *   · 审批   —— 批没批、为什么驳
 *
 * ── ⚠️ 工具的参数里**没有单号** ──
 *
 * 这是安全边界，不是设计洁癖。单号由服务端从本次请求里绑定，工具只拿得到
 * `expenseId`。如果让模型自己传单号，一个被注入的提问（「顺便查一下 BX-2026-0001」）
 * 就能让它读任意一条数据 —— 那是最经典的越权。
 * 同理，工具也不接受「查全表」「按条件搜」这类参数：模型能触及的数据范围
 * 必须由**服务端**决定，不能由它的输出决定。
 */

export interface ToolRunContext {
  /** 本次请求绑定的单子。模型无法改变它。 */
  expenseId: string;
  prisma: PrismaService;
}

export interface ToolOutcome {
  ok: boolean;
  /** 回给模型的内容。**永远**是结构化对象，不是一段自然语言。 */
  payload: unknown;
  /** 这次返回里允许被引用的字段路径（由 payload 遍历出来）。 */
  fields: string[];
}

export interface AgentTool {
  spec: LlmToolSpec;
  run(context: ToolRunContext): Promise<ToolOutcome>;
}

/** 无参工具的 JSON Schema。`additionalProperties:false` 是在告诉模型「别自己加参数」。 */
const NO_ARGS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const getExpenseSummary: AgentTool = {
  spec: {
    name: 'get_expense_summary',
    description:
      '查这张报销单的表头信息：单号、标题、申请人、部门、分类、报销总额、当前状态、提交时间。' +
      '不包含费用明细和审批意见。',
    parameters: NO_ARGS,
  },
  async run({ expenseId, prisma }) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      select: {
        code: true,
        title: true,
        applicant: true,
        department: true,
        category: true,
        amount: true,
        status: true,
        submittedAt: true,
      },
    });
    if (!expense) return missing('这张报销单已经不存在了');

    return ok(buildExpenseHeader(expense));
  },
};

const listExpenseItems: AgentTool = {
  spec: {
    name: 'list_expense_items',
    description:
      '列出这张报销单的所有费用明细：每条的名称、分类、金额、费用实际发生日期（spentOn），' +
      '以及合计金额。费用发生日与提交日期是两回事。',
    parameters: NO_ARGS,
  },
  async run({ expenseId, prisma }) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      // 只选工具需要的列。真实系统里这一步还该带权限过滤，
      // 现在没有多租户，但「工具自己查、自己限定列」这个形状先立住。
      select: {
        code: true,
        amount: true,
        items: {
          orderBy: { spentOn: 'asc' },
          select: {
            name: true,
            category: true,
            amount: true,
            spentOn: true,
            note: true,
          },
        },
      },
    });
    if (!expense) return missing('这张报销单已经不存在了');

    return ok(buildExpenseItems(expense));
  },
};

const getApprovalRecord: AgentTool = {
  spec: {
    name: 'get_approval_record',
    description:
      '查这张报销单的审批记录：当前状态、决策时间（decidedAt）、驳回原因（rejectReason）。' +
      '草稿或待审批的单子没有决策信息，此时这两个字段不会出现 —— 这表示数据不足，不是出错。',
    parameters: NO_ARGS,
  },
  async run({ expenseId, prisma }) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      select: {
        code: true,
        status: true,
        decidedAt: true,
        rejectReason: true,
      },
    });
    if (!expense) return missing('这张报销单已经不存在了');

    // 复用整页 context 的构造规则：可空字段只在有值时出现。
    // 这样「数据里没有」和「模型编了一个」在字段层面始终分得开。
    return ok(buildApprovalRecord(expense));
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  getExpenseSummary,
  listExpenseItems,
  getApprovalRecord,
];

/** 发给模型的工具说明。顺序固定，便于评测和日志比对。 */
export const TOOL_SPECS: LlmToolSpec[] = AGENT_TOOLS.map((tool) => tool.spec);

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.spec.name === name);
}

function ok(payload: unknown): ToolOutcome {
  return { ok: true, payload, fields: fieldsOf(asRecord(payload)) };
}

/**
 * 「单子没了」不是工具执行失败，而是**模型该知道的业务结果**。
 * 报 `ok:false` 会让上层把它当成系统故障记 error 日志；它不是。
 */
function missing(message: string): ToolOutcome {
  return { ok: true, payload: { error: message }, fields: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
