import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import type {
  LlmCompletion,
  LlmProvider,
  LlmRequestOptions,
  LlmStream,
} from '../src/modules/llm/llm.types.js';
import { LLM_PROVIDER } from '../src/modules/llm/llm.types.js';

/**
 * 并发上限 (e2e)。
 *
 * 单测钉的是守卫自己的计数，这里钉的是接上真 HTTP 之后才成立的几件事：
 * 被拒的请求拿到的是**开流之前的 429 JSON**（而不是一条已经开始的流），
 * 以及客户端断开以后额度真的还回去了。
 *
 * 用一个「永远不说话」的 provider 把请求摁在飞行中 —— 用真 mock 的话，
 * 它答得太快，第二个请求到达时第一个早就结束了，这条用例什么也证明不了。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */
class HangingProvider implements LlmProvider {
  readonly name = 'hanging';

  /** 已经进入 provider 的请求数：轮询它，确保第一个请求真的占住了额度。 */
  started = 0;

  complete(): Promise<LlmCompletion> {
    this.started += 1;
    // 永不返回。客户端断开时会话会走另一条路，这个 promise 只是被丢下。
    return new Promise<LlmCompletion>(() => undefined);
  }

  async stream(
    _messages: unknown,
    options?: LlmRequestOptions,
  ): Promise<LlmStream> {
    this.started += 1;
    const signal = options?.signal;
    const events = (async function* () {
      // 先吐一个「还没解出结论」的片段：证明流确实开了，
      // 但页面上一个字都不该出现（增量解析器这时候什么都解不出来）。
      yield { type: 'text' as const, text: '{"conclusion":"' };
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    })();
    return { model: 'hanging', events };
  }
}

describe('并发上限 (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const stub = new HangingProvider();
  const originalLimit = process.env.MAX_CONCURRENT_ASKS;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(stub)
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (originalLimit === undefined) delete process.env.MAX_CONCURRENT_ASKS;
    else process.env.MAX_CONCURRENT_ASKS = originalLimit;
    await app.close();
  });

  beforeEach(() => {
    process.env.MAX_CONCURRENT_ASKS = '1';
  });

  const body = { code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' };

  function startStream(signal?: AbortSignal): Promise<Response> {
    return fetch(`${baseUrl}/assistant/askStream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000,
  ): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * 起一条流，遇到 429 就小睡重试。
   *
   * 上一条用例刚 abort 过，额度是异步还的 —— 这里如果直接起，
   * 偶尔会撞上「还没还」，测试就成了看运气。
   */
  async function startStreamSoon(signal: AbortSignal): Promise<Response> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const response = await startStream(signal);
      if (response.status !== 429) return response;
      await response.text();
      if (Date.now() > deadline) throw new Error('额度一直没有还回来');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('额度占满时，另一个端点立刻 429，而不是排队', async () => {
    const base = stub.started;
    const first = new AbortController();
    const response = await startStream(first.signal);
    expect(response.status).toBe(200);
    // 等它真的走进 provider：那之前 `prepare()` 还没跑完，请求可能根本没占到额度。
    await waitFor(() => stub.started > base);

    // 换一个端点打：两个模型端点共用同一份额度。
    const rejected = await fetch(`${baseUrl}/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as { message: string }).message).toContain(
      '请稍后再试',
    );

    first.abort();
  });

  it('客户端断开之后，额度立刻还回去', async () => {
    const base = stub.started;
    const first = new AbortController();
    const response = await startStreamSoon(first.signal);
    expect(response.status).toBe(200);
    await waitFor(() => stub.started > base);

    first.abort();
    // 额度是在响应的 `close` 上还的，和断开在同一个事件循环里；
    // 留一点余量，但不需要等到模型那边收尾。
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = new AbortController();
    const again = await startStreamSoon(second.signal);
    expect(again.status).toBe(200);
    second.abort();
  });

  it('MAX_CONCURRENT_ASKS=0 表示不限制', async () => {
    process.env.MAX_CONCURRENT_ASKS = '0';

    const first = new AbortController();
    const second = new AbortController();
    const [a, b] = await Promise.all([
      startStream(first.signal),
      startStream(second.signal),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    first.abort();
    second.abort();
  });
});
