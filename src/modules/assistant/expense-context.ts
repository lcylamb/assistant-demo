import type { Expense, ExpenseItem } from '../../generated/prisma/client.js';

export type ExpenseWithItems = Expense & { items: ExpenseItem[] };

export interface ExpenseContext {
  /** 喂给模型的 JSON。只放字段本身，不放数据库的主键、外键这类内部列。 */
  record: Record<string, unknown>;
  /**
   * 允许被引用的字段路径全集。
   *
   * 它是由 `record` **遍历出来的**，不是手写的清单 —— 这一点是刻意的：
   * 凡是能引用到的字段，都真的是我们给过模型的；模型引用了别的，就是它自己编的。
   * 防幻觉不需要另一套白名单，一份数据只描述一次。
   */
  availableFields: string[];
}

/**
 * 把一条报销单摊平成「给模型看的 JSON + 可引用字段清单」。
 *
 * 两个刻意的处理：
 *
 * 1. **可空字段只在有值时才出现。** `rejectReason` 为 null 时不写进 JSON，
 *    于是 `rejectReason` 也不会出现在 availableFields 里。这条单子问「为什么被驳回」，
 *    模型引用 `rejectReason` 就会被判为幻觉 —— 但正确答案是「信息不足」，
 *    它应该 cite status 然后说 insufficient。这两条路必须能分开，
 *    否则「数据里没有」和「模型编了一个」在日志里长得一模一样。
 *
 * 2. **Decimal 转成字符串。** 金额从库里取出来是 Decimal 对象，
 *    直接 JSON.stringify 会变成一个 `{s,e,d}` 的结构体，模型看不懂。
 *    用 toFixed(2) 保证 `2766.00` 而不是 `2766` —— 金额的小数位是信息的一部分。
 */
export function buildExpenseContext(expense: ExpenseWithItems): ExpenseContext {
  const record: Record<string, unknown> = {
    code: expense.code,
    title: expense.title,
    applicant: expense.applicant,
    department: expense.department,
    category: expense.category,
    amount: expense.amount.toFixed(2),
    status: expense.status,
    submittedAt: expense.submittedAt.toISOString(),
    items: expense.items.map((item) => {
      const row: Record<string, unknown> = {
        name: item.name,
        category: item.category,
        amount: item.amount.toFixed(2),
        spentOn: item.spentOn.toISOString(),
      };
      if (item.note) row.note = item.note;
      return row;
    }),
  };

  if (expense.decidedAt) record.decidedAt = expense.decidedAt.toISOString();
  if (expense.rejectReason) record.rejectReason = expense.rejectReason;

  const availableFields: string[] = [];
  collectPaths(record, '', availableFields);

  return { record, availableFields };
}

/**
 * 遍历出所有可引用的路径。
 *
 * 数组本身也可以被引用（`items`），元素则是 `items[0].name` 这样的下标路径 ——
 * 因为模型看到的就是这个形状，它能说出什么，我们就得认什么。
 */
function collectPaths(value: unknown, prefix: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (prefix) out.push(prefix);
    value.forEach((child, index) =>
      collectPaths(child, `${prefix}[${index}]`, out),
    );
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectPaths(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }

  if (prefix) out.push(prefix);
}
