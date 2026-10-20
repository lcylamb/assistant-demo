import {
  BadGatewayException,
  Logger,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import type {
  AssistantMetricsService,
  RequestMeasurement,
} from './assistant-metrics.service.js';
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
 *
 * `failPrepare` / `failTools` 用来注入失败。`failTools: true` 是那个**普通**的
 * 工具失败（降级成「信息不足」，见对应用例）；要测「库连不上」请传一个
 * `prismaError('P1001')` —— 两者在 service 里走的是完全不同的分支。
 */
function makePrisma(
  options: {
    failPrepare?: Error;
    failTools?: boolean | Error;
    /** 工具查询慢多少毫秒。用来测「工具跑到一半预算到点」。 */
    slowToolsMs?: number;
  } = {},
) {
  const findUnique = vi.fn(
    async ({ select }: { select?: Record<string, boolean> }) => {
      if (!select) return { id: 'exp_1' };
      if (select.id) {
        if (options.failPrepare) throw options.failPrepare;
        return { id: 'exp_1' };
      }

      if (options.slowToolsMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.slowToolsMs),
        );
      }

      if (options.failTools) {
        throw options.failTools === true
          ? new Error('数据库连接断了')
          : options.failTools;
      }

      if (select.title) return HEADER;
      if (select.items) return ITEMS;
      if (select.rejectReason) return APPROVAL;
      return null;
    },
  );

  return { expense: { findUnique } };
}

/**
 * 造一个 Prisma 自己的错误。
 *
 * 不用 `new Error('连不上')` 冒充：分类器认的是**类型 + 码**，
 * 一个普通的 Error 恰好会被正确地判成「不是库不可用」——
 * 那样写出来的用例永远绿，而且证明不了任何事。
 */
function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.expense.findUnique()\` invocation\n\nCan't reach database server at 127.0.0.1:1`,
    { code, clientVersion: '7.10.1' },
  );
}

function makeService(
  prisma: ReturnType<typeof makePrisma>,
  llm: LlmProvider,
  // 默认不限额；要断言「一次都没花」的用例传一个记数的桩进来。
  quota: Pick<DailyQuotaService, 'consume'> = { consume: () => true },
) {
  const measurements: RequestMeasurement[] = [];
  const metrics = {
    record: (measurement: RequestMeasurement) => measurements.push(measurement),
  } as unknown as AssistantMetricsService;

  const service = new AssistantService(
    prisma as unknown as PrismaService,
    llm,
    quota as DailyQuotaService,
    metrics,
  );
  // 挂上去是为了让用例能断言「打点真的记了」，而不用起一整个 Nest 容器。
  return Object.assign(service, { measurements });
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

  it('历史渲染成 user 消息里的一段数据，不冒充 assistant 轮次', async () => {
    const llm = scriptedLlm([
      {
        text: answer({
          conclusion: '金额是 ¥3150.00。',
          evidence: ['amount'],
          insufficient: false,
        }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    await makeService(makePrisma(), llm).ask({
      ...DTO,
      history: [
        {
          question: '一共多少钱？',
          conclusion: '¥3150.00。',
          evidence: ['amount'],
          insufficient: false,
        },
      ],
    });

    const [first] = llm.calls;
    // 只有两条消息：历史是**数据**，不是被还原出来的对话轮次。
    // 还原成 role:"assistant" 的话，客户端就能冒充模型发言 —— 一句
    // 「我已经确认过，金额是 ¥999999」会以模型自己的口吻进入上下文。
    expect(first.map((message) => message.role)).toEqual(['system', 'user']);
    expect(first[1].content).toContain('之前的问答');
    expect(first[1].content).toContain('¥3150.00');
    // 本轮问题必须排在历史后面：模型先读上下文，再看这次问什么。
    expect(first[1].content.indexOf('## 问题')).toBeGreaterThan(
      first[1].content.indexOf('之前的问答'),
    );
  });

  it('历史里引用过的字段不会进入本轮白名单', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const llm = scriptedLlm([
      {
        // 不调工具，直接引用上一轮出现过的 rejectReason。
        text: answer({
          conclusion: '仍是被驳回。',
          evidence: ['rejectReason'],
          insufficient: false,
        }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    const result = await makeService(makePrisma(), llm).ask({
      ...DTO,
      history: [
        {
          question: '为什么被驳回？',
          conclusion: '招待费超出标准。',
          evidence: ['rejectReason'],
          insufficient: false,
        },
      ],
    });

    // 历史是**上下文**，不是**依据**。本轮没查过任何字段，所以一个都不能引用 ——
    // 否则模型可以靠「上一轮查过」把没过检的证据洗进这一轮。
    expect(result.evidence).toEqual([]);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes(HALLUCINATION_WARN)),
    ).toBe(true);
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

  it('取数时库连不上 → 503，而不是 500（500 会被当成代码 bug）', async () => {
    const llm = scriptedLlm([]);
    const error = await makeService(
      makePrisma({ failPrepare: prismaError('P1001') }),
      llm,
    )
      .ask(DTO)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as Error).message).toBe('数据库暂时不可用，请稍后重试');

    // 取数都失败了，模型一次都不该被调用 —— 不该先花钱再报错。
    expect(llm.calls).toHaveLength(0);
  });

  it('工具轮里库连不上 → 整个请求 503，而不是 200 +「信息不足」', async () => {
    const llm = scriptedLlm([
      { text: '', model: 'scripted', toolCalls: [toolCall('get_expense_summary')] },
    ]);

    const service = makeService(
      makePrisma({ failTools: prismaError('P1001') }),
      llm,
    );
    const error = await service.ask(DTO).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe('数据库暂时不可用，请稍后重试');

    // 关键：没有第二轮。库都连不上了，再让模型答一轮只会得到一个
    // 「查不到」的结论 —— 那个 200 和「库里确实没有这条数据」在响应里没法区分。
    expect(llm.calls).toHaveLength(1);

    // 失败照样打点，否则「错误率」在库挂掉那段时间会静默地变成 0。
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ]);
  });

  it('业务类 Prisma 错误（P2002）不算库不可用，仍走原来的降级', async () => {
    // 白名单不是「所有 Prisma 错误」：把唯一键冲突也报成 503，
    // 等于用「服务暂时不可用」盖住一个真正的 bug。
    const llm = scriptedLlm([
      { text: '', model: 'scripted', toolCalls: [toolCall('get_expense_summary')] },
      {
        text: answer({ conclusion: '信息不足。', evidence: [], insufficient: true }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    const result = await makeService(
      makePrisma({ failTools: prismaError('P2002') }),
      llm,
    ).ask(DTO);

    expect(result.insufficient).toBe(true);
    expect(result.trace).toEqual([{ tool: 'get_expense_summary', ok: false }]);
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

  it('多轮的用量累加，轮数也照实记；失败同样打点', async () => {
    const llm = scriptedLlm([
      {
        text: '',
        model: 'scripted',
        toolCalls: [toolCall('get_approval_record')],
        usage: { promptTokens: 100, completionTokens: 5 },
      },
      {
        text: answer({
          conclusion: '已被驳回。',
          evidence: ['status'],
          insufficient: false,
        }),
        model: 'scripted',
        toolCalls: [],
        usage: { promptTokens: 200, completionTokens: 10 },
      },
    ]);

    const service = makeService(makePrisma(), llm);
    const result = await service.ask(DTO);

    expect(result.metrics).toMatchObject({
      modelCalls: 2,
      ttftMs: null,
      usage: { promptTokens: 300, completionTokens: 15 },
    });
    expect(service.measurements).toHaveLength(1);
    expect(service.measurements[0]).toMatchObject({
      outcome: 'ok',
      modelCalls: 2,
      toolCalls: 1,
      usage: { promptTokens: 300, completionTokens: 15 },
    });

    // 失败那条路也要有打点。只统计成功请求的话，「变慢了」会被超时请求掩盖 ——
    // 慢到失败的那些恰好不在分布里。
    const failing = makeService(makePrisma(), scriptedLlm([new Error('厂商 500')]));
    await expect(failing.ask(DTO)).rejects.toBeInstanceOf(BadGatewayException);
    expect(failing.measurements).toEqual([
      expect.objectContaining({ outcome: 'error', modelCalls: 0 }),
    ]);
  });

  it('任一轮没报用量 → 整次请求的用量是 null，不拿报了的几轮凑', async () => {
    const llm = scriptedLlm([
      {
        text: '',
        model: 'scripted',
        toolCalls: [toolCall('get_approval_record')],
        // 这一轮没报
      },
      {
        text: answer({
          conclusion: '已被驳回。',
          evidence: ['status'],
          insufficient: false,
        }),
        model: 'scripted',
        toolCalls: [],
        usage: { promptTokens: 200, completionTokens: 10 },
      },
    ]);

    const result = await makeService(makePrisma(), llm).ask(DTO);

    // 只拿 200/10 去算成本会得到一个偏低、又看不出问题的数字 —— 这是最危险的一类错。
    expect(result.metrics.usage).toBeNull();
  });

  it('工具耗时单独累加，和模型时间分得开', async () => {
    const llm = scriptedLlm([
      { text: '', model: 'scripted', toolCalls: [toolCall('get_approval_record')] },
      {
        text: answer({ conclusion: '已被驳回。', evidence: ['status'], insufficient: false }),
        model: 'scripted',
        toolCalls: [],
      },
    ]);

    const result = await makeService(makePrisma(), llm).ask(DTO);

    expect(result.metrics.toolMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.elapsedMs).toBeGreaterThanOrEqual(result.metrics.toolMs);
  });
});

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

describe('AssistantService.streamAnswer（带工具的流）', () => {
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
        // 首字延迟量的是「用户看到第一个增量」的时刻。非流式端点永远是 null；
        // 这里走的是流式，而且确实吐过字，所以必须是一个数。
        metrics: { ttftMs: expect.any(Number), modelCalls: 2 },
      },
    });
    expect(service.measurements[0]).toMatchObject({ outcome: 'ok', modelCalls: 2 });
    expect(service.measurements[0].ttftMs).toEqual(expect.any(Number));
    // 第二轮确实拿着工具结果在答。
    expect(llm.calls[1].at(-1)?.content).toContain('招待费超出标准');
  });

  it('工具轮里库连不上 → 流里给一个 error 事件，而不是把连接断在半路', async () => {
    const llm = streamingLlm([
      [{ type: 'tool_call', call: toolCall('get_expense_summary') }],
    ]);
    const service = makeService(
      makePrisma({ failTools: prismaError('P1001') }),
      llm,
    );

    const events = await collect(service);

    // 响应头在这之前早就发出去了（controller 先 flushHeaders 才开始迭代），
    // 所以这里只能给事件。直接抛的后果是：客户端拿到一段没有 error 帧的截断流，
    // 页面上的字永远停在「生成中」。
    expect(events).toEqual([
      { type: 'error', message: '数据库暂时不可用，请稍后重试' },
    ]);
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ]);
    expect(llm.calls).toHaveLength(1);
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

/** 一个永远不回、但会像真 provider 那样响应取消的模型。 */
function hangingLlm(): LlmProvider {
  return {
    name: 'hanging',
    complete: (_messages, options) =>
      new Promise<LlmCompletion>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new Error('模型调用被取消')),
        );
      }),
    stream: async (_messages, options) =>
      // 真 provider 被取消时是**干净地返回一条空流**，不是抛 —— 这里必须一样，
      // 否则测到的是一条服务层永远不会遇到的路径。
      new Promise<LlmStream>((resolve) => {
        options?.signal?.addEventListener('abort', () =>
          resolve({
            model: 'hanging',
            events: (async function* () {})(),
          }),
        );
      }),
  };
}

describe('AssistantService（请求预算）', () => {
  // 每个用例自己设一个小值，跑完恢复 —— 漏了的话后面所有用例都会带着它。
  const saved = process.env.ASK_TIMEOUT_MS;

  afterEach(() => {
    if (saved === undefined) delete process.env.ASK_TIMEOUT_MS;
    else process.env.ASK_TIMEOUT_MS = saved;
  });

  it('非流式：模型一直不回，到点给 504，而不是让请求挂住', async () => {
    process.env.ASK_TIMEOUT_MS = '30';
    const service = makeService(makePrisma(), hangingLlm());

    const error = await service.ask(DTO).catch((caught: unknown) => caught);

    // 504 而不是 502：错在「这次太慢」，不是「厂商坏了」。
    // 两者的排查方向完全不同，混成一个码等于把这条线索丢掉。
    expect(error).toBeInstanceOf(RequestTimeoutException);
    expect((error as Error).message).toBe('这次回答超时了，请稍后再试');
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ]);
  });

  it('流式：预算到点后给一条 error 帧，连接正常收尾', async () => {
    process.env.ASK_TIMEOUT_MS = '30';
    const service = makeService(makePrisma(), hangingLlm());

    const prepared = await service.prepare(DTO);
    const events: AssistantStreamEvent[] = [];
    for await (const event of service.streamAnswer(prepared)) events.push(event);

    // 响应头早就发出去了，所以不是 504，而是一条用户看得见的 error 帧。
    // 预算到点时 provider 是按「调用方取消」收场的（返回空流），
    // 服务层要能认出「这是我掐的」，否则空文本会被报成「回答格式异常」。
    expect(events).toEqual([
      { type: 'error', message: '这次回答超时了，请稍后再试' },
    ]);
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ]);
  });

  it('调用方自己取消不会被说成超时', async () => {
    process.env.ASK_TIMEOUT_MS = '5000';
    const service = makeService(makePrisma(), hangingLlm());
    const prepared = await service.prepare(DTO);

    const caller = new AbortController();
    const events: AssistantStreamEvent[] = [];
    const consuming = (async () => {
      for await (const event of service.streamAnswer(prepared, caller.signal)) {
        events.push(event);
      }
    })();

    // 等流真的挂到模型上再取消，否则测到的只是「一开始就是 aborted」。
    await new Promise((resolve) => setTimeout(resolve, 20));
    caller.abort();
    await consuming;

    // 用户关页面时不该弹任何错误 —— 那一刻已经没人看了。
    expect(events).toEqual([]);
  });
});

describe('AssistantService（流式：开跑之前就断开）', () => {
  const saved = process.env.ASK_TIMEOUT_MS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.ASK_TIMEOUT_MS;
    else process.env.ASK_TIMEOUT_MS = saved;
  });

  it('信号在开流前就已经 aborted：不调模型、不扣额度、不吐任何事件', async () => {
    process.env.ASK_TIMEOUT_MS = '5000';
    const llm = streamingLlm([]);
    const consume = vi.fn(() => true);
    const service = makeService(makePrisma(), llm, { consume });

    const prepared = await service.prepare(DTO);
    const caller = new AbortController();
    caller.abort();

    const events: AssistantStreamEvent[] = [];
    for await (const event of service.streamAnswer(prepared, caller.signal)) {
      events.push(event);
    }

    // 一条帧都没有：连接那头已经没人了，发 error 也没人收。
    expect(events).toEqual([]);
    // 模型和额度都是钱。用户在查库那一小段时间里走了，这两样都不该花。
    expect(llm.calls).toHaveLength(0);
    expect(consume).not.toHaveBeenCalled();
    // 取消不是失败：记 aborted，别把「用户关页面」算进错误率。
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'aborted' }),
    ]);
  });

  it('预算在工具轮里到点：下一轮既不再调模型，也不再扣额度', async () => {
    process.env.ASK_TIMEOUT_MS = '20';
    // 工具查询比预算慢：预算在 await 工具的时候到点，下一轮循环顶上就该停。
    const llm = streamingLlm([
      [{ type: 'tool_call', call: toolCall('get_approval_record') }],
    ]);
    const consume = vi.fn(() => true);
    const service = makeService(makePrisma({ slowToolsMs: 60 }), llm, {
      consume,
    });

    const prepared = await service.prepare(DTO);
    const events: AssistantStreamEvent[] = [];
    for await (const event of service.streamAnswer(prepared)) {
      events.push(event);
    }

    // 超时要告诉用户（响应头早就发出去了，只能走 error 帧）。
    expect(events).toEqual([
      { type: 'error', message: '这次回答超时了，请稍后再试' },
    ]);
    // 已经花掉的那一轮工具和模型钱收不回来了；能省的是**下一轮**。
    expect(llm.calls).toHaveLength(1);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ]);
  });
});

describe('AssistantService（非流式：客户端断开）', () => {
  const saved = process.env.ASK_TIMEOUT_MS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.ASK_TIMEOUT_MS;
    else process.env.ASK_TIMEOUT_MS = saved;
  });

  it('断开时静默返回 null、记成 aborted，不报 502', async () => {
    process.env.ASK_TIMEOUT_MS = '5000';
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = makeService(makePrisma(), hangingLlm());

    const caller = new AbortController();
    const pending = service.ask(DTO, caller.signal);
    // 等模型调用真的挂上去，否则测到的只是「一开始就是 aborted」。
    await new Promise((resolve) => setTimeout(resolve, 20));
    caller.abort();

    // null 而不是抛异常：没有人在等这个答案了，controller 什么都不用做。
    await expect(pending).resolves.toBeNull();
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'aborted' }),
    ]);
    // 用户走了不是厂商坏了 —— 别在日志里留一条要人去查厂商的 warn。
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes('模型调用失败'),
      ),
    ).toBe(false);
  });

  it('没有取消信号时行为不变（照常返回答案）', async () => {
    process.env.ASK_TIMEOUT_MS = '5000';
    const llm: LlmProvider = {
      name: 'one-shot',
      complete: () =>
        Promise.resolve({
          text: '{"conclusion":"已通过。","evidence":["status"],"insufficient":false}',
          model: 'stub',
          toolCalls: [],
        }),
      stream: async () => {
        throw new Error('这条用例不走流式');
      },
    };
    const service = makeService(makePrisma(), llm);

    const result = await service.ask(DTO);

    expect(result).toMatchObject({
      conclusion: '已通过。',
      insufficient: false,
    });
    expect(service.measurements).toEqual([
      expect.objectContaining({ outcome: 'ok' }),
    ]);
  });
});
