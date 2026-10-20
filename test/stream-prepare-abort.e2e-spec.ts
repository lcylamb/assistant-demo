import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import { AssistantService } from '../src/modules/assistant/assistant.service.js';
import type { MetricsSnapshot } from '../src/modules/assistant/assistant-metrics.service.js';
import type {
  LlmCompletion,
  LlmProvider,
  LlmStream,
} from '../src/modules/llm/llm.types.js';
import { LLM_PROVIDER } from '../src/modules/llm/llm.types.js';

/**
 * 流式端点：**取数阶段**的客户端断开。
 *
 * `prepare()`（查单号）跑在写响应头之前，所以它的取消信号必须比响应头更早挂上。
 * 原先 `res.on('close')` 是在 `flushHeaders()` 之后才挂的：用户恰好在查库那一小段
 * 时间里关掉页面，信号就没人接 —— 接下来照样往一个死连接写响应头，再叫一次模型、
 * 吃掉一次额度。`test/assistant-abort.e2e-spec.ts` 覆盖的是「流已经开始之后」，
 * 这条用例补的是它前面那一段。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */
class CountingProvider implements LlmProvider {
  readonly name = 'counting';

  /** 走到模型层的次数。这个用例里它必须一直是 0。 */
  calls = 0;

  async complete(): Promise<LlmCompletion> {
    this.calls += 1;
    throw new Error('取数期间就断开了，不该走到非流式模型调用');
  }

  async stream(): Promise<LlmStream> {
    this.calls += 1;
    throw new Error('取数期间就断开了，不该走到流式模型调用');
  }
}

describe('流式：取数阶段客户端断开 (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const stub = new CountingProvider();

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const metrics = async (): Promise<MetricsSnapshot> =>
    (
      await fetch(`${baseUrl}/assistant/metrics`)
    ).json() as Promise<MetricsSnapshot>;

  it('取数期间断开：不写流、不开模型、不花额度，也不记成一次失败', async () => {
    const assistant = app.get(AssistantService);
    const originalPrepare = assistant.prepare.bind(assistant);
    let prepareStarted!: () => void;
    let prepareFinished = false;
    const started = new Promise<void>((resolve) => {
      prepareStarted = resolve;
    });

    // 把查库拖长，给客户端留出「就在这一小段里走掉」的窗口。
    // 拖的是真正的 `prepare()`，不是另写一个假实现 —— 要测的正是 controller
    // 在**真实的取数流程**中间能不能接住断开。
    vi.spyOn(assistant, 'prepare').mockImplementation(async (dto) => {
      prepareStarted();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const prepared = await originalPrepare(dto);
      prepareFinished = true;
      return prepared;
    });

    // 单独盯住 `streamAnswer`：controller 早退与否，最直接的证据是它有没有被调用。
    // `vi.spyOn` 默认就是调用原方法的，这里只需要它记一笔。
    const streamSpy = vi.spyOn(assistant, 'streamAnswer');

    const before = await metrics();
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/assistant/askStream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'BX-2026-0003',
        question: '这张单子为什么被驳回了？',
      }),
      signal: controller.signal,
    }).catch(() => 'aborted' as const);

    // 等它真的进入取数再走 —— 之前走掉只是「请求还没到」。
    await started;
    controller.abort();
    await pending;

    // 等服务端把那一小段取数跑完，再给它一拍走完早退分支。
    await waitFor(
      async () => prepareFinished,
      (finished) => finished,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 关键断言：模型一次都没被叫。响应头没写出去，也就没有「流里补一条 error」可言。
    expect(streamSpy).not.toHaveBeenCalled();
    expect(stub.calls).toBe(0);

    const after = await metrics();
    // 取数阶段就结束的请求没有会话可打点 —— 和「单号不存在 / 库不可用」同一口径。
    // 特别是 `errors` 不能涨：用户走了不是一次失败。
    expect(after.totals.ok).toBe(before.totals.ok);
    expect(after.totals.errors).toBe(before.totals.errors);
    expect(after.totals.aborted).toBe(before.totals.aborted);
  });
});

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
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
