import { BadGatewayException, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AssistantService, HALLUCINATION_WARN } from './assistant.service.js';
import type {
  LlmCompletion,
  LlmMessage,
  LlmProvider,
  LlmRequestOptions,
  LlmStream,
  LlmStreamEvent,
  LlmToolCall,
} from '../llm/llm.types.js';
import type { DailyQuotaService } from '../llm/daily-quota.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AgentSession } from './assistant.service.js';
import type { AssistantStreamEvent } from './ask.types.js';

/**
 * Agent 循环的单测。
 *
 * ── 为什么这个文件不能是 e2e ──
 *
 * e2e 能证明「结果对」，但证明不了**中间过程**：模型到底在第几轮拿到了什么、
 * 复用了哪几条消息、工具失败时它有没有被告知。这些恰恰是循环最容易写错、
 * 也最难从最终答案倒推的地方（答得对可能只是碰巧）。
 *
 * 所以这里把一个**脚本化的假模型**塞进去：它按预设的第 N 轮返回工具调用或答案，
 * 同时把每一轮收到的 messages 记下来。于是「第二轮看得到第一轮的工具结果」
 * 这种断言才写得出来 —— 而在真模型上，这种错误的表现只是「答得不太对」。
 *
 * 数据库也用桩：工具查询的形状由 select 决定，这里按 select 回不同的行。
 * 连库的话这个文件会变成 e2e 的半个复制品，还要一个 Postgres 才跑得起来。
 */

// ─────────────────────────────────────────────────────────────
// 桩：数据
// ─────────────────────────────────────────────────────────────

const HEADER = {
  code: 'BX-2026-0003',
  title: '客户答谢晚宴',
  applicant: '王五',
  department: '市场部',
  category: 'ENTERTAIN',
  amount: new Prisma.Decimal('3150.00'),
  status: 'REJECTED',
  submittedAt: new Date('2026-04-02T00:00:00Z'),
};

const APPROVAL = {
  code: 'BX-2026-0003',
  status: 'REJECTED',
  decidedAt: new Date('2026-04-05T00:00:00Z'),
  rejectReason: '招待费超出标准',
};

const ITEMS = {
  code: 'BX-2026-0003',
  amount: new Prisma.Decimal('3150.00'),
  items: [
    {
      name: '晚宴',
      category: 'ENTERTAIN',
      amount: new Prisma.Decimal('3000.00'),
      spentOn: new Date('2026-03-30T00:00:00Z'),
      note: null,
    },
  ],
};

/**
 * 按 `select` 回不同的行。
 *
 * 判断顺序不重要 —— 三个工具的 select 互不重叠（`prepare()` 只要 id）。
 * 哪个 select 里出现了那个工具的招牌列，就回那块数据。
 */
function makePrisma(options: { failTools?: boolean } = {}) {
  const findUnique = vi.fn(
    async ({ select }: { select?: Record<string, boolean> }) => {
      if (!select) return { id: 'exp_1' };
      if (select.id) return { id: 'exp_1' };

      if (options.failTools) throw new Error('数据库连接断了');

      if (select.title) return HEADER;
      if (select.items) return ITEMS;
      if (select.rejectReason) return APPROVAL;
      return null;
    },
  );

  return { expense: { findUnique } };
}

function makeService(prisma: ReturnType<typeof makePrisma>, llm: LlmProvider) {
  const quota = { consume: () => true } as unknown as DailyQuotaService;
  return new AssistantService(prisma as unknown as PrismaService, llm, quota);
}

// ─────────────────────────────────────────────────────────────
// 桩：模型
// ─────────────────────────────────────────────────────────────

function toolCall(name: string, id = 'call_1'): LlmToolCall {
  return { id, name, arguments: '{}' };
}

function answer(body: unknown): string {
  return `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;
}

/**
 * 按轮次回预设结果的模型，同时记下每一轮收到的 messages。
 *
 * ⚠️ 记 messages 的时候要**深拷贝**：service 是往同一个数组里 push 的，
 * 存引用的话，事后断言看到的会是最终状态 —— 每一轮都"看起来"包含了工具结果，
 * 于是这条测试就永远绿，而且毫无价值。
 */
function scriptedLlm(script: Array<LlmCompletion | Error>): LlmProvider & {
  calls: LlmMessage[][];
} {
  const calls: LlmMessage[][] = [];
  let index = 0;

  const next = (messages: LlmMessage[]): LlmCompletion => {
    calls.push(structuredClone(messages));
    const step = script[index++];
    if (!step) throw new Error('假模型的脚本用完了');
    if (step instanceof Error) throw step;
    return step;
  };

  return {
    name: 'scripted',
    calls,
    async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
      return next(messages);
    },
    async stream(): Promise<LlmStream> {
      throw new Error('这个用例不走流式');
    },
  };
}

const DTO = { code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' };

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────

describe('AssistantService（Agent 循环）', () => {
  it('第一轮只给工具、不给数据；第二轮才拿到工具结果作答', async () => {
    const llm = scriptedLlm([
      { text: '', model: 'scripted', toolCalls: [toolCall('get_approval_record')] },
      {
        text: answer({
          conclusion: '已被驳回，原因是招待费超出标准。',
          evidence: ['status', 'rejectReason'],
          insufficient: false,
        }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    const result = await makeService(makePrisma(), llm).ask(DTO);

    expect(result.conclusion).toContain('招待费超出标准');
    // trace 是服务端根据**实际执行**生成的，不是模型说的。
    expect(result.trace).toEqual([{ tool: 'get_approval_record', ok: true }]);

    // 第一轮：prompt 里只有单号和问题。这是这一版和「把数据塞进 prompt」的分水岭 ——
    // 数据一旦提前出现，模型就没有必要调工具了，工具调用会退化成摆设。
    const first = JSON.stringify(llm.calls[0]);
    expect(first).toContain('BX-2026-0003');
    expect(first).not.toContain('招待费超出标准');
    expect(first).not.toContain('3150.00');

    // 第二轮：assistant 的 tool_calls 和 tool 结果按 id 配对。
    // 缺了任何一条，厂商都会直接 400 —— 而错误会出现在离病因很远的地方。
    const second = llm.calls[1];
    expect(second.at(-2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'call_1', name: 'get_approval_record' }],
    });
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    expect(second.at(-1)?.content).toContain('招待费超出标准');
  });

  it('模型报了不存在的工具：回告它，不崩，并记成失败的一步', async () => {
    const llm = scriptedLlm([
      {
        text: '',
        model: 'scripted',
        toolCalls: [toolCall('read_any_expense', 'call_x')],
      },
      {
        text: answer({
          conclusion: '信息不足。',
          evidence: [],
          insufficient: true,
        }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    const prisma = makePrisma();
    const result = await makeService(prisma, llm).ask(DTO);

    expect(result.trace).toEqual([{ tool: 'read_any_expense', ok: false }]);
    // 除了 prepare() 的那一次，不应该再碰数据库 —— 未知工具不能被执行。
    expect(prisma.expense.findUnique).toHaveBeenCalledTimes(1);
    expect(llm.calls[1].at(-1)?.content).toContain('没有名为 read_any_expense 的工具');
  });

  it('工具执行失败也回一条 tool 消息 —— 否则下一轮请求结构不完整', async () => {
    const llm = scriptedLlm([
      { text: '', model: 'scripted', toolCalls: [toolCall('get_expense_summary')] },
      {
        text: answer({
          conclusion: '信息不足。',
          evidence: [],
          insufficient: true,
        }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    // prepare() 成功、工具查询失败。
    const prisma = makePrisma({ failTools: true });
    const result = await makeService(prisma, llm).ask(DTO);

    expect(result.trace).toEqual([{ tool: 'get_expense_summary', ok: false }]);
    expect(llm.calls[1].at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
  });

  it('依据的白名单是**本次查过的**字段，不是整张单子的字段', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const llm = scriptedLlm([
      { text: '', model: 'scripted', toolCalls: [toolCall('get_approval_record')] },
      {
        // title 在库里存在，但这次没查表头 —— 引用它就是「没看就敢说」。
        text: answer({
          conclusion: '已被驳回。',
          evidence: ['status', 'rejectReason', 'title'],
          insufficient: false,
        }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    const result = await makeService(makePrisma(), llm).ask(DTO);

    expect(result.evidence).toEqual(['status', 'rejectReason']);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes(HALLUCINATION_WARN)),
    ).toBe(true);
  });

  it('一直要工具时会在上限处停下，不会无限烧 token', async () => {
    const llm = scriptedLlm(
      Array.from({ length: 10 }, () => ({
        text: '',
        model: 'scripted',
        toolCalls: [toolCall('get_expense_summary')],
      })),
    );

    const error = await makeService(makePrisma(), llm)
      .ask(DTO)
      .then(() => {
        throw new Error('这个请求本该失败，却成功了');
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as Error).message).toContain('反复调用工具');
    expect(llm.calls).toHaveLength(4);
  });

  it('模型调用抛错 → 502，而不是 500（500 会让上游去翻代码）', async () => {
    const llm = scriptedLlm([new Error('厂商 500')]);

    await expect(makeService(makePrisma(), llm).ask(DTO)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AssistantService.streamAnswer（带工具的流）', () => {
  /** 按轮次回预设事件流的模型。 */
  function streamingLlm(rounds: LlmStreamEvent[][]): LlmProvider & {
    calls: LlmMessage[][];
  } {
    const calls: LlmMessage[][] = [];
    let index = 0;

    return {
      name: 'scripted',
      calls,
      async complete(): Promise<LlmCompletion> {
        throw new Error('这个用例不走非流式');
      },
      async stream(
        messages: LlmMessage[],
        _options?: LlmRequestOptions,
      ): Promise<LlmStream> {
        calls.push(structuredClone(messages));
        const events = rounds[index++];
        if (!events) throw new Error('假模型的脚本用完了');
        return {
          model: 'scripted',
          events: (async function* () {
            yield* events;
          })(),
        };
      },
    };
  }

  async function collect(
    service: AssistantService,
    session?: AgentSession,
  ): Promise<AssistantStreamEvent[]> {
    const prepared = session ?? (await service.prepare(DTO));
    const out: AssistantStreamEvent[] = [];
    for await (const event of service.streamAnswer(prepared)) out.push(event);
    return out;
  }

  it('工具轮里模型先说的人话不往外吐，最终结论照常增量输出', async () => {
    const llm = streamingLlm([
      [
        // 模型在调工具前先客套一句 —— jsonMode 下少见，关掉时很常见。
        { type: 'text', text: '我先查一下审批记录。' },
        { type: 'tool_call', call: toolCall('get_approval_record') },
      ],
      [
        { type: 'text', text: '```json\n{"conclusion":"' },
        { type: 'text', text: '已被驳回' },
        { type: 'text', text: '","evidence":["status"],"insufficient":false}\n```' },
      ],
    ]);

    const service = makeService(makePrisma(), llm);
    const events = await collect(service);

    const deltas = events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text);
    const done = events.find((event) => event.type === 'done');

    // 那句客套话不是答案。吐出去的话，页面上会出现「我先查一下审批记录。已被驳回」，
    // 而 done 里的结论只有后半句 —— 用户看到的和接口给的对不上。
    expect(deltas.join('')).toBe('已被驳回');
    expect(done).toMatchObject({
      type: 'done',
      data: {
        conclusion: '已被驳回',
        trace: [{ tool: 'get_approval_record', ok: true }],
      },
    });
    // 第二轮确实拿着工具结果在答。
    expect(llm.calls[1].at(-1)?.content).toContain('招待费超出标准');
  });

  it('一次都不调工具时，行为和非流式一致（同一套收口）', async () => {
    const llm = streamingLlm([
      [{ type: 'text', text: answer({ conclusion: '不需要查。', evidence: [], insufficient: true }) }],
    ]);

    const events = await collect(makeService(makePrisma(), llm));
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      type: 'done',
      data: { conclusion: '不需要查。', insufficient: true, trace: [] },
    });
  });
});
