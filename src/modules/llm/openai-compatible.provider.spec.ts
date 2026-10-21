import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LlmMessage, LlmStreamEvent, LlmToolSpec } from './llm.types.js';
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleConfig,
} from './openai-compatible.provider.js';

/**
 * 真 provider 的单测。
 *
 * ── 为什么起一个真服务器，而不是 stub 掉 fetch ──
 *
 * stub fetch 的话，测的其实是「我写的那个 stub 和我想的一样」——
 * 断帧、`{stream:true}` 解码、abort 会不会真的把连接掐掉，这些**恰恰是
 * 真正会出错的地方**，而它们在 stub 里全都不存在。
 *
 * 起一个 `http.createServer` 只多十几行，换来的是：真的走 TCP、真的被切包、
 * 真的能验证 abort 传到了对端。这个项目里「管道」是主角，那就别把它 stub 掉。
 *
 * 端口用 0（让系统分配），不写死 —— 写死的话 CI 上撞端口就会红，
 * 而那种红和代码无关，最容易被当成 flaky 忽略掉。
 */

const SECRET = 'sk-test-not-a-real-key';
const MODEL = 'vendor-model';
const MESSAGES: LlmMessage[] = [{ role: 'user', content: '你好' }];

interface Recorded {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

const servers: Server[] = [];

/** 起一个假厂商。`respond` 里想怎么写就怎么写。 */
async function startVendor(
  respond: (res: ServerResponse, body: Record<string, unknown>) => void,
): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const record: Recorded = {
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      };
      requests.push(record);
      respond(res, record.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);

  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // ⚠️ 必须先掐掉还挂着的连接。abort 那几条用例留下的连接不会自己走，
          // `close()` 会一直等它们 —— 症状是 vitest 跑完不退出，而不是某个用例失败。
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function makeProvider(
  baseUrl: string,
  overrides: Partial<OpenAiCompatibleConfig> = {},
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    apiKey: SECRET,
    baseUrl,
    model: 'test-model',
    timeoutMs: 2_000,
    maxAttempts: 3,
    maxTokens: 256,
    jsonMode: true,
    streamUsage: true,
    ...overrides,
  });
}

/** 写一帧厂商 SSE。 */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textFrame(content: string): string {
  return frame({ model: MODEL, choices: [{ index: 0, delta: { content } }] });
}

function openStream(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
}

async function drainEvents(
  events: AsyncIterable<LlmStreamEvent>,
): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** 大多数流式用例只关心文本 —— 工具调用有单独一条用例专门验。 */
async function drain(events: AsyncIterable<LlmStreamEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const event of events) {
    if (event.type === 'text') out.push(event.text);
  }
  return out;
}

/**
 * 等一个**本该失败**的调用，把错误取出来。
 *
 * 不用 `.catch(e => e as Error)`：那样一旦调用其实成功了，拿到的会是一个
 * `LlmCompletion`，而后面对 `.message` 的断言会以一个和病因毫无关系的方式失败。
 * 这里成功就直接炸，失败得明确。
 */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('这个请求本该失败，却成功了');
}

describe('OpenAiCompatibleProvider', () => {
  describe('启动自检', () => {
    it.each([
      ['LLM_API_KEY', { apiKey: '   ' }],
      ['LLM_BASE_URL', { baseUrl: '  ' }],
      ['LLM_MODEL', { model: '' }],
    ])('缺 %s 时直接抛，并点名是哪个', (name, overrides) => {
      // 不这么做的代价是：启动成功、每次提问都失败，而错误出现在离病因很远的地方。
      expect(() => makeProvider('http://127.0.0.1:1/v1', overrides)).toThrow(name);
    });
  });

  describe('complete', () => {
    it('拿回文本和厂商报的模型名', async () => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: MODEL,
            choices: [{ message: { role: 'assistant', content: '{"conclusion":"好"}' } }],
          }),
        );
      });

      expect(await makeProvider(baseUrl).complete(MESSAGES)).toEqual({
        text: '{"conclusion":"好"}',
        model: MODEL,
        // 纯文本回答也要显式给空数组，不是 undefined ——
        // 调用方可以无脑读 `completion.toolCalls.length`，不用先判存在。
        toolCalls: [],
      });
    });

    it('把厂商报的用量带回来；没报时是 undefined，不是 0', async () => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: MODEL,
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 120, completion_tokens: 8 },
          }),
        );
      });

      expect((await makeProvider(baseUrl).complete(MESSAGES)).usage).toEqual({
        promptTokens: 120,
        completionTokens: 8,
      });

      // 另一台厂商什么都不报。这里必须是 undefined：「这笔没花 token」和
      // 「不知道花了多少」在成本核算上是两件事，用 0 冒充会让总额偏低。
      const silent = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, choices: [{ message: { content: 'ok' } }] }));
      });

      expect((await makeProvider(silent.baseUrl).complete(MESSAGES)).usage).toBeUndefined();
    });

    it('只报了一半用量的实现按「没报」处理 —— 半份数据不能拿去算钱', async () => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: MODEL,
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 120 },
          }),
        );
      });

      expect((await makeProvider(baseUrl).complete(MESSAGES)).usage).toBeUndefined();
    });

    it('请求按约定拼好', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, choices: [{ message: { content: 'ok' } }] }));
      });

      await makeProvider(baseUrl).complete(MESSAGES);

      const [sent] = requests;
      expect(sent.url).toBe('/v1/chat/completions');
      expect(sent.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(sent.body.messages).toEqual(MESSAGES);
      expect(sent.body.stream).toBe(false);
      // 温度必须是 0：评测的断言建立在「同一份数据问同一个问题，答案稳定」上。
      expect(sent.body.temperature).toBe(0);
      expect(sent.body.max_tokens).toBe(256);
      // 结构化输出的第一层（约束）。第二层是 parseAnswer，撤掉哪层都不行。
      expect(sent.body.response_format).toEqual({ type: 'json_object' });
    });

    it('LLM_JSON_MODE=false 时不带 response_format', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, choices: [{ message: { content: 'ok' } }] }));
      });

      await makeProvider(baseUrl, { jsonMode: false }).complete(MESSAGES);
      expect(requests[0].body).not.toHaveProperty('response_format');
    });

    it('响应里没有 choices[0].message.content 时抛，并带上原文片段', async () => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, choices: [] }));
      });

      await expect(makeProvider(baseUrl).complete(MESSAGES)).rejects.toThrow(
        /没有 choices\[0\]\.message\.content/,
      );
    });

    it('200 但 body 不是 JSON 时抛，而不是把 null 一路传下去', async () => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('<html>502 Bad Gateway</html>');
      });

      await expect(makeProvider(baseUrl).complete(MESSAGES)).rejects.toThrow(
        /没有 choices\[0\]\.message\.content/,
      );
    });

    it('只有 tool_calls、没有文本时算成功 —— 那一轮本来就不该说话', async () => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: MODEL,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'get_expense_summary', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
        );
      });

      // 把「没有 content」一律当成失败，是接工具调用时最典型的错误：
      // 每一个正常的工具轮都会被误判成厂商异常，而模型其实答得好好的。
      expect(await makeProvider(baseUrl).complete(MESSAGES)).toEqual({
        text: '',
        model: MODEL,
        toolCalls: [{ id: 'call_1', name: 'get_expense_summary', arguments: '{}' }],
      });
    });

    it('工具的定义和上一轮的调用历史按厂商线格式发出去', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, choices: [{ message: { content: 'ok' } }] }));
      });

      const tools: LlmToolSpec[] = [
        {
          name: 'get_expense_summary',
          description: '查表头',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      ];
      const history: LlmMessage[] = [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'get_expense_summary', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"code":"BX-1"}' },
      ];

      await makeProvider(baseUrl).complete(history, { tools });

      const [sent] = requests;
      expect(sent.body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'get_expense_summary',
            description: '查表头',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ]);
      // 显式 auto：查不查由模型定，这个产品决定值得写进请求里而不是靠默认值。
      expect(sent.body.tool_choice).toBe('auto');
      // 三条都不能省：assistant 的 tool_calls 不原样回传 → 模型以为调用凭空消失；
      // tool 结果不带 tool_call_id → 厂商直接 400，而且报错位置离病因很远；
      // 内部字段（这里没有，但以后可能有）也不能顺着发出去。
      expect(sent.body.messages).toEqual([
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_expense_summary', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"code":"BX-1"}' },
      ]);
    });

    it('不传 tools 时请求里没有 tools / tool_choice', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, choices: [{ message: { content: 'ok' } }] }));
      });

      await makeProvider(baseUrl).complete(MESSAGES);

      expect(requests[0].body).not.toHaveProperty('tools');
      expect(requests[0].body).not.toHaveProperty('tool_choice');
    });
  });

  describe('失败要说清楚，但绝不回显密钥', () => {
    it.each([
      [401, '检查 LLM_API_KEY'],
      [402, '余额不足'],
      [429, '厂商限流'],
      [500, ''],
    ])('HTTP %i 时错误里带上状态码和提示', async (status, hint) => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
      });

      const error = await failure(makeProvider(baseUrl).complete(MESSAGES));

      expect(error.message).toContain(String(status));
      if (hint) expect(error.message).toContain(hint);
      // 这一条不是「顺手加的」：日志、异常和评测报告都可能被贴到别处去，
      // 「密钥绝不会被我们自己打出来」必须是结构上成立的（只读响应，不回显请求头），
      // 而不是靠每次改代码时都记得别写错。
      expect(error.message).not.toContain(SECRET);
    });

    it('连不上时说的是连接问题，不是「模型答错了」', async () => {
      // 1 端口上不会有人监听。
      const error = await failure(makeProvider('http://127.0.0.1:1/v1').complete(MESSAGES));

      expect(error.message).toContain('连不上模型厂商');
      expect(error.message).not.toContain(SECRET);
    });

    it('超时会被认出来，且说的是超时', async () => {
      const { baseUrl } = await startVendor(() => {
        // 什么都不做：连接建起来，但永远不响应。
      });

      const error = await failure(
        makeProvider(baseUrl, { timeoutMs: 60 }).complete(MESSAGES),
      );

      expect(error.message).toContain('超时');
    });
  });

  describe('临时失败会重试，但不是什么都重试', () => {
    it('503 是瞬时的：重试一次就好了', async () => {
      let calls = 0;
      const { baseUrl, requests } = await startVendor((res) => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'overloaded' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: MODEL,
            choices: [{ message: { role: 'assistant', content: '好' } }],
          }),
        );
      });

      const result = await makeProvider(baseUrl).complete(MESSAGES);

      expect(result.text).toBe('好');
      expect(requests).toHaveLength(2);
    });

    it('密钥错了不重试 —— 再试一百次也是同样的结果', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
      });

      const error = await failure(makeProvider(baseUrl).complete(MESSAGES));

      expect(error.message).toContain('401');
      expect(requests).toHaveLength(1);
    });

    it('厂商说「60 秒后再来」时不硬等 —— 直接告诉用户这次失败了', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        res.writeHead(429, {
          'Retry-After': '60',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      });

      const error = await failure(makeProvider(baseUrl).complete(MESSAGES));

      // 等一分钟和直接失败，对用户来说是后者更诚实。
      expect(error.message).toContain('429');
      expect(requests).toHaveLength(1);
    });

    it('连接被重置也会重试 —— 这类失败来得快，重试便宜', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        // 请求收到了，但一个响应头都不给就掐断。
        res.destroy();
      });

      await failure(makeProvider(baseUrl).complete(MESSAGES));

      expect(requests).toHaveLength(3);
    });

    it('maxAttempts=1 时完全不重试', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'overloaded' } }));
      });

      await failure(
        makeProvider(baseUrl, { maxAttempts: 1 }).complete(MESSAGES),
      );

      expect(requests).toHaveLength(1);
    });

    it('流式：第一次 503，重试成功后增量不会重复', async () => {
      let calls = 0;
      const { baseUrl, requests } = await startVendor((res) => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'overloaded' } }));
          return;
        }
        openStream(res);
        res.write(textFrame('你'));
        res.write(textFrame('好'));
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);

      expect(await drain(stream.events)).toEqual(['你', '好']);
      expect(requests).toHaveLength(2);
    });

    it('流式：响应头到了、首帧还没到连接就断了 —— 第一个字之前，可以重试', async () => {
      let calls = 0;
      const { baseUrl, requests } = await startVendor((res) => {
        calls += 1;
        if (calls === 1) {
          openStream(res);
          // 响应头写完了，一个数据帧都没有，连接就没了。
          setTimeout(() => res.destroy(), 20);
          return;
        }
        openStream(res);
        res.write(textFrame('好'));
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);

      expect(await drain(stream.events)).toEqual(['好']);
      expect(requests).toHaveLength(2);
    });

    it('流式：首帧超时不重试 —— 已经等满一整个时限了', async () => {
      const { baseUrl, requests } = await startVendor(() => {
        // 连接建起来，但永远不响应。
      });

      const error = await failure(
        makeProvider(baseUrl, { timeoutMs: 60 }).stream(MESSAGES),
      );

      expect(error.message).toContain('第一个字超时');
      expect(requests).toHaveLength(1);
    });

    it('流式：已经开始吐字之后再出错，不重试 —— 否则同一段话会吐两遍', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        openStream(res);
        res.write(textFrame('半句'));
        // 吐了半句，然后把连接掐掉。
        setTimeout(() => res.destroy(), 20);
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);

      await expect(drain(stream.events)).rejects.toThrow();
      expect(requests).toHaveLength(1);
    });
  });

  describe('stream', () => {
    it('模型名取自帧里，且首帧那段文字不会丢', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        // 首帧只有 role —— 真实厂商都这么开头。
        res.write(frame({ model: MODEL, choices: [{ delta: { role: 'assistant' } }] }));
        res.write(textFrame('你'));
        res.write(textFrame('好'));
        res.write(frame({ model: MODEL, choices: [], usage: { total_tokens: 9 } }));
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);

      // `test-model` 是配置里的，`vendor-model` 才是厂商在流里报的。
      // 取错的话，日志和页面上标的来源就是假的。
      expect(stream.model).toBe(MODEL);
      // ⚠️ 这条挡的是「为了读模型名而提前拉出来的那一帧被丢掉」——
      // 症状是答案少头几个字，而流本身一切正常。
      expect(await drain(stream.events)).toEqual(['你', '好']);
    });

    it('厂商一个 model 字段都没给时退回配置值', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(frame({ choices: [{ delta: { content: '好' } }] }));
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);
      expect(stream.model).toBe('test-model');
    });

    it('[DONE] 和心跳注释不会被当成内容', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(': keep-alive\n\n');
        res.write(textFrame('好'));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);
      expect(await drain(stream.events)).toEqual(['好']);
    });

    it('鉴权失败在返回之前就抛 —— 那时上层还没往外写过任何增量', async () => {
      const { baseUrl } = await startVendor((res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
      });

      // 这正是 LlmStream 那个形状的理由：错误必须发生在第一个字之前，
      // 否则调用方（SSE 响应头早就发出去了）只能给用户半句话加一个莫名的结束。
      await expect(makeProvider(baseUrl).stream(MESSAGES)).rejects.toThrow(/401/);
    });

    it('厂商在流中间回错误时，迭代到那里才抛', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(textFrame('你'));
        res.write(frame({ error: { message: '额度用尽' } }));
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);
      await expect(drain(stream.events)).rejects.toThrow(/额度用尽/);
    });

    it('响应头到了但首帧不来，算超时', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        // 头显式刷出去，然后一个数据帧都不发。
        res.flushHeaders();
      });

      await expect(
        makeProvider(baseUrl, { timeoutMs: 60 }).stream(MESSAGES),
      ).rejects.toThrow(/等待模型第一个字超时/);
    });

    it('连接接下了却连响应头都不回，也算超时 —— 不能无限等下去', async () => {
      // ⚠️ 这一条挡的是一个很容易漏掉的洞：如果时限是从「响应头到齐」才开始算的，
      // 这种情况会永远挂着。厂商过载时就是这样 —— 它接下了连接，然后什么都不回。
      const { baseUrl } = await startVendor(() => {
        // 什么都不做。
      });

      await expect(
        makeProvider(baseUrl, { timeoutMs: 60 }).stream(MESSAGES),
      ).rejects.toThrow(/等待模型第一个字超时/);
    });

    it('吐了一个字之后彻底沉默：不会无限等下去', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(textFrame('一'));
        // 然后既不发帧也不 end —— 模拟「上游半死」：
        // 连接看着还在，数据永远不来。心跳还会替它续命，症状是「生成中」一直转。
      });

      const stream = await makeProvider(baseUrl, { timeoutMs: 60 }).stream(MESSAGES);
      const startedAt = Date.now();

      // 关键是它在**时限附近**就结束，而不是挂到测试超时。
      await expect(drain(stream.events)).rejects.toThrow(/停住/);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    it('帧还在来就不算停住 —— 答得慢不该被腰斩', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        let sent = 0;
        const timer = setInterval(() => {
          if (sent === 5) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(textFrame(String(sent)));
          sent += 1;
        }, 20);
      });

      // 每帧间隔 20ms、闲置上限 200ms：只要「每来一帧就重置计时器」是对的，
      // 这条慢流就不会被掐。写成「整条流总时限」的话，这条会红。
      const stream = await makeProvider(baseUrl, { timeoutMs: 200 }).stream(MESSAGES);
      expect(await drain(stream.events)).toEqual(['0', '1', '2', '3', '4']);
    });

    it('调用方取消：干净地结束，不抛', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        // 挂着不发 —— 模拟「模型还在想，用户已经关了页面」。
      });

      const controller = new AbortController();
      const pending = makeProvider(baseUrl, { timeoutMs: 5_000 }).stream(MESSAGES, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 30);

      // 取消**不是**失败。这一条如果变成 rejects，上层就会往一条已经关掉的
      // 连接上写错误事件 —— 用户早就走了，看到的是一堆无意义的报错日志。
      const stream = await pending;
      expect(await drain(stream.events)).toEqual([]);
    });

    it('流到一半被取消：迭代正常收尾，不抛', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(textFrame('一'));
        res.write(textFrame('二'));
        // 不 end，保持连接开着。
      });

      const controller = new AbortController();
      const stream = await makeProvider(baseUrl).stream(MESSAGES, {
        signal: controller.signal,
      });

      const got: string[] = [];
      for await (const event of stream.events) {
        if (event.type === 'text') got.push(event.text);
        controller.abort();
      }

      expect(got[0]).toBe('一');
      // 「一」之后还有「二」在路上的时候断开，迭代必须**正常结束**：
      // 上层靠「循环走完了 + signal.aborted」来判断是用户走人，而不是出错。
    });

    it('工具调用碎片按 index 拼成完整调用，且在流末才发出来', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(frame({ model: MODEL, choices: [{ delta: { role: 'assistant' } }] }));
        // 第一片带 id 和函数名，参数是空的 —— 实测 DeepSeek 就是这么发的。
        res.write(
          frame({
            model: MODEL,
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_a',
                      type: 'function',
                      function: { name: 'get_expense_summary', arguments: '' },
                    },
                  ],
                },
              },
            ],
          }),
        );
        res.write(
          frame({
            model: MODEL,
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } },
            ],
          }),
        );
        res.write(
          frame({ model: MODEL, choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        );
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);

      // ⚠️ 第一条碎片是在 `prime()` 里为了定模型名提前拉出来的。它必须被
      // 带出那一步 —— 丢了的话症状是「模型说它调了工具，服务端一个都没执行」，
      // 而流本身看起来完全正常。
      expect(await drainEvents(stream.events)).toEqual([
        {
          type: 'tool_call',
          call: { id: 'call_a', name: 'get_expense_summary', arguments: '{}' },
        },
      ]);
    });

    it('并行调两个工具时按 index 分开累加，碎片交错也不会串', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(
          frame({
            model: MODEL,
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_a', function: { name: 'get_expense_summary' } },
                    { index: 1, id: 'call_b', function: { name: 'list_expense_items' } },
                  ],
                },
              },
            ],
          }),
        );
        // 参数一段段来，而且两个调用交错着来 —— 真厂商就是这样。
        res.write(
          frame({
            model: MODEL,
            choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"x"' } }] } }],
          }),
        );
        res.write(
          frame({
            model: MODEL,
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"y":2}' } }] } }],
          }),
        );
        res.write(
          frame({
            model: MODEL,
            choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':1}' } }] } }],
          }),
        );
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);

      // 结果按 index 排序而不是按到达顺序：调用方的执行顺序应该稳定，
      // 否则同一份输入两次跑出两种轨迹，轨迹断言就没法写了。
      expect(await drainEvents(stream.events)).toEqual([
        {
          type: 'tool_call',
          call: { id: 'call_a', name: 'get_expense_summary', arguments: '{"y":2}' },
        },
        {
          type: 'tool_call',
          call: { id: 'call_b', name: 'list_expense_items', arguments: '{"x":1}' },
        },
      ]);
    });

    it('同一帧里既有文本又有工具碎片时，两样都不丢', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        res.write(
          frame({
            model: MODEL,
            choices: [
              {
                delta: {
                  content: '前缀',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_a',
                      function: { name: 'get_expense_summary', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
        );
        res.end();
      });

      const stream = await makeProvider(baseUrl).stream(MESSAGES);

      // 这种帧不常见，但「不常见」不等于「不会发生」。原来那一版对带碎片的帧
      // 直接 continue，文本会被静默吞掉 —— 症状是答案偶尔少一句，流看起来正常。
      expect(await drainEvents(stream.events)).toEqual([
        { type: 'text', text: '前缀' },
        {
          type: 'tool_call',
          call: { id: 'call_a', name: 'get_expense_summary', arguments: '{}' },
        },
      ]);
    });

    it('工具轮没有文本时不会撞上首帧超时', async () => {
      const { baseUrl } = await startVendor((res) => {
        openStream(res);
        // 只有工具碎片，一个文本帧都没有。首帧的判据如果只看文本，
        // `stream()` 会一直等到时限（60ms）才失败 —— 而这时它本该已经返回了。
        res.write(
          frame({
            model: MODEL,
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_a', function: { name: 'get_expense_summary' } },
                  ],
                },
              },
            ],
          }),
        );
        // 故意不 end、也不发文本。
        //
        // ⚠️ 这里**不消费 events**：这条用例只关心信封（stream()）能不能回来。
        // 流末的沉默归下面那条「吐了一个字之后彻底沉默」管 —— 从这一版起，
        // 帧与帧之间沉默过久本身就会被判成停住，消费它反而测不到首帧判定。
      });

      const stream = await makeProvider(baseUrl, { timeoutMs: 60 }).stream(MESSAGES);
      expect(stream.model).toBe(MODEL);
    });

    it('流末尾那一帧用量会变成 usage 事件，请求里也开了 include_usage', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        openStream(res);
        res.write(textFrame('好'));
        // 厂商在 [DONE] 之前单独发一帧：choices 为空，只有 usage。
        // 把它当成「没有内容」丢掉，流式端点就永远没有 token 数。
        res.write(
          frame({
            model: MODEL,
            choices: [],
            usage: { prompt_tokens: 30, completion_tokens: 5 },
          }),
        );
        res.end('data: [DONE]\n\n');
      });

      const events = await drainEvents((await makeProvider(baseUrl).stream(MESSAGES)).events);

      expect(events).toContainEqual({
        type: 'usage',
        usage: { promptTokens: 30, completionTokens: 5 },
      });
      // 不打开这个字段，厂商根本不会发上面那一帧 —— 要测就一起测。
      expect(requests[0].body.stream_options).toEqual({ include_usage: true });
    });

    it('LLM_STREAM_USAGE=false 时不发 stream_options（少数实现不认这个字段）', async () => {
      const { baseUrl, requests } = await startVendor((res) => {
        openStream(res);
        res.write(textFrame('好'));
        res.end('data: [DONE]\n\n');
      });

      await drainEvents(
        (await makeProvider(baseUrl, { streamUsage: false }).stream(MESSAGES)).events,
      );

      expect(requests[0].body).not.toHaveProperty('stream_options');
    });
  });
});
