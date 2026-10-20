import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LlmMessage } from './llm.types.js';
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
    maxTokens: 256,
    jsonMode: true,
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

async function drain(chunks: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of chunks) out.push(chunk);
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
      });
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
      expect(await drain(stream.chunks)).toEqual(['你', '好']);
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
      expect(await drain(stream.chunks)).toEqual(['好']);
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
      await expect(drain(stream.chunks)).rejects.toThrow(/额度用尽/);
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
      expect(await drain(stream.chunks)).toEqual([]);
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
      for await (const chunk of stream.chunks) {
        got.push(chunk);
        controller.abort();
      }

      expect(got[0]).toBe('一');
      // 「一」之后还有「二」在路上的时候断开，迭代必须**正常结束**：
      // 上层靠「循环走完了 + signal.aborted」来判断是用户走人，而不是出错。
    });
  });
});
