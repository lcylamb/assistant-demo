import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import type { MetricsSnapshot } from '../src/modules/assistant/assistant-metrics.service.js';
import type {
  LlmCompletion,
  LlmProvider,
  LlmRequestOptions,
  LlmStream,
} from '../src/modules/llm/llm.types.js';
import { LLM_PROVIDER } from '../src/modules/llm/llm.types.js';

/**
 * 非流式端点的「客户端断开」。
 *
 * 流式那条路径一直会掐掉模型调用（见 assistant-abort.e2e-spec.ts）；非流式
 * 以前没人管 —— 用户关掉页面之后，请求照样跑满每一轮，token 照烧。
 * 这条用例从 HTTP 层证明那个信号真的接上了：断开 → 模型调用被取消 → 打点记 aborted。
 *
 * 用原生 fetch + AbortController 而不是 supertest：要的正是「请求发出去、
 * 服务端已经挂到模型上之后，再把连接掐掉」这个时刻。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */
class HangingProvider implements LlmProvider {
  readonly name = 'hanging';

  /** 已经挂到模型上的请求数。 */
  started = 0;
  /** 被取消信号真正掐掉的模型调用数。 */
  aborted = 0;
  mode: 'hang' | 'ok' = 'hang';

  complete(
    _messages: unknown,
    options?: LlmRequestOptions,
  ): Promise<LlmCompletion> {
    if (this.mode === 'ok') {
      return Promise.resolve({
        text: '{"conclusion":"没有足够的信息。","evidence":[],"insufficient":true}',
        model: 'stub',
        toolCalls: [],
      });
    }

    this.started += 1;
    return new Promise<LlmCompletion>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => {
          this.aborted += 1;
          reject(new Error('模型调用被取消'));
        },
        { once: true },
      );
    });
  }

  async stream(): Promise<LlmStream> {
    throw new Error('这条用例不走流式');
  }
}

describe('非流式：客户端断开 (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const stub = new HangingProvider();

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
    await app.close();
  });

  beforeEach(() => {
    stub.mode = 'hang';
  });

  const metrics = async (): Promise<MetricsSnapshot> =>
    (
      await fetch(`${baseUrl}/assistant/metrics`)
    ).json() as Promise<MetricsSnapshot>;

  async function waitFor<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
  ) {
    const startedAt = Date.now();
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() - startedAt > 2000) {
        throw new Error(`等不到预期状态，最后一次：${JSON.stringify(value)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const body = { code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' };

  it('客户端断开后，在途的模型调用被取消，并且记成 aborted 而不是 error', async () => {
    const before = await metrics();
    const base = stub.started;
    const controller = new AbortController();

    const pending = fetch(`${baseUrl}/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch(() => 'aborted' as const);

    // 等它真的走进模型：那之前还没什么可取消的。
    await waitFor(
      async () => stub.started,
      (started) => started > base,
    );

    controller.abort();
    await pending;

    // provider 收到的是调用方取消，而不是厂商故障。
    await waitFor(
      async () => stub.aborted,
      (aborted) => aborted > 0,
    );

    const after = await waitFor(
      metrics,
      (snapshot) => snapshot.totals.aborted > before.totals.aborted,
    );
    // 取消不是失败：要是记成 error，错误率会被「用户关页面」这件事抬高。
    expect(after.totals.errors).toBe(before.totals.errors);
  });

  it('没有断开时，这个端点照常返回 JSON（新加的 @Res 没有改变正常路径）', async () => {
    stub.mode = 'ok';

    const response = await fetch(`${baseUrl}/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { conclusion: string }).toMatchObject({
      conclusion: '没有足够的信息。',
      insufficient: true,
    });
  });
});
