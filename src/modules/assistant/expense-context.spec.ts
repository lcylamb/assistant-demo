import {
  ExpenseCategory,
  ExpenseStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { buildExpenseContext, type ExpenseWithItems } from './expense-context.js';

/**
 * 造一条和 seed 里 BX-2026-0003 同形的记录。
 *
 * 不连数据库 —— 这个文件测的是「摊平规则」，不是「查询对不对」。
 * 查询那部分归 e2e。
 */
function makeExpense(overrides: Partial<ExpenseWithItems> = {}): ExpenseWithItems {
  return {
    id: 'exp_1',
    code: 'BX-2026-0003',
    title: '客户答谢晚宴',
    applicant: '王五',
    department: '市场部',
    category: ExpenseCategory.ENTERTAIN,
    amount: new Prisma.Decimal('2766.00'),
    status: ExpenseStatus.REJECTED,
    rejectReason: '招待费超出部门月度预算，且缺少参与人员清单',
    submittedAt: new Date('2026-03-15T10:40:00.000Z'),
    decidedAt: new Date('2026-03-18T03:10:00.000Z'),
    items: [
      {
        id: 'itm_1',
        expenseId: 'exp_1',
        name: '客户晚餐（6 人）',
        category: ExpenseCategory.ENTERTAIN,
        amount: new Prisma.Decimal('2680.00'),
        note: null,
        spentOn: new Date('2026-03-14T00:00:00.000Z'),
      },
      {
        id: 'itm_2',
        expenseId: 'exp_1',
        name: '餐后交通',
        category: ExpenseCategory.TRANSPORT,
        amount: new Prisma.Decimal('86.00'),
        note: '打车',
        spentOn: new Date('2026-03-14T00:00:00.000Z'),
      },
    ],
    ...overrides,
  };
}

describe('buildExpenseContext', () => {
  it('金额转成两位小数的字符串，不是 Decimal 对象', () => {
    const { record } = buildExpenseContext(makeExpense());
    expect(record.amount).toBe('2766.00');
    expect(typeof record.amount).toBe('string');
  });

  it('不把数据库内部列暴露给模型', () => {
    const { record, availableFields } = buildExpenseContext(makeExpense());
    expect(record).not.toHaveProperty('id');
    expect(availableFields).not.toContain('id');
    expect(availableFields).not.toContain('expenseId');
  });

  it('可引用字段涵盖数组本身和元素的下标路径', () => {
    const { availableFields } = buildExpenseContext(makeExpense());
    expect(availableFields).toContain('items');
    expect(availableFields).toContain('items[0].name');
    expect(availableFields).toContain('items[1].amount');
  });

  describe('可空字段', () => {
    it('有值时出现在数据里，也可被引用', () => {
      const { record, availableFields } = buildExpenseContext(makeExpense());
      expect(record.rejectReason).toBeTruthy();
      expect(availableFields).toContain('rejectReason');
      expect(availableFields).toContain('decidedAt');
    });

    // 这一组是整个防幻觉设计的支点：数据里没有的字段，模型就引不到；
    // 一旦它还是引了，那就只可能是它自己编的 —— 「缺数据」和「编数据」
    // 因此在日志里能分开。
    it('rejectReason 为 null 时既不出现在数据里，也不在可引用清单里', () => {
      const { record, availableFields } = buildExpenseContext(
        makeExpense({ rejectReason: null, status: ExpenseStatus.DRAFT }),
      );
      expect(record).not.toHaveProperty('rejectReason');
      expect(availableFields).not.toContain('rejectReason');
    });

    it('decidedAt 为 null 时同上', () => {
      const { record, availableFields } = buildExpenseContext(
        makeExpense({ decidedAt: null, status: ExpenseStatus.DRAFT }),
      );
      expect(record).not.toHaveProperty('decidedAt');
      expect(availableFields).not.toContain('decidedAt');
    });

    it('明细的 note 为 null 时同上', () => {
      const { availableFields } = buildExpenseContext(makeExpense());
      expect(availableFields).not.toContain('items[0].note');
      expect(availableFields).toContain('items[1].note');
    });
  });

  it('清单里的每一个路径都真的能在数据里取到（不是手写的白名单）', () => {
    const { record, availableFields } = buildExpenseContext(makeExpense());

    for (const path of availableFields) {
      expect(readPath(record, path), `路径 ${path} 在数据里取不到`).toBeDefined();
    }
  });
});

/** 按 `items[0].name` 这种路径取值。和 expense-context 里的拼法是镜像关系。 */
function readPath(root: unknown, path: string): unknown {
  const tokens = path.match(/[^.[\]]+/g) ?? [];
  let cursor: unknown = root;

  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string, unknown>)[token];
  }

  return cursor;
}
