import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import type { MetricsSnapshot } from '../src/modules/assistant/assistant-metrics.service.js';

/**
 * 客户端断开时的行为。
 *
 * ── 为什么这条要单独一个 e2e ──
 *
 * 「用户关掉页面，服务端就停下来」是流式服务里最容易被写成一句自述的话：
 * 读代码时能看到 `abort()`，但看不到它和真实 socket 关闭之间有没有接上。
 * 中间任何一环断掉（`close` 判错了、signal 没传进 provider、generator 没在
 * 检查点退出），表现都是「接口照常返回，只是账单慢慢变多」—— 没有报错，
 * 也没有任何一个最终答案会因此变错。
 *
 * 所以这里不用 supertest：它面向的是「一个完整的请求-响应」，
 * 而我们需要的恰好是**发起请求、读到一个增量、然后主动把连接掐掉**。
 * 用原生 `fetch` + `AbortController` 才能把那个时刻握在手里。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */
describe('客户端断开 (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    // 不用 supertest 的 `app.getHttpServer()`：这条用例要拿着端口自己发请求。
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const metrics = async (): Promise<MetricsSnapshot> =>
    (await fetch(`${baseUrl}/assistant/metrics`)).json() as Promise<MetricsSnapshot>;

  /** 打点是在生成器 finally 里写的，断开之后要给它一点时间。 */
  async function waitFor(
    predicate: (snapshot: MetricsSnapshot) => boolean,
    timeoutMs = 3000,
  ): Promise<MetricsSnapshot> {
    const startedAt = Date.now();
    let last = await metrics();
    while (!predicate(last)) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`等不到预期的打点，最后一次快照：${JSON.stringify(last)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      last = await metrics();
    }
    return last;
  }

  it('读到第一个增量后断开：服务端停下，记成 aborted 而不是 ok / error', async () => {
    const before = await metrics();
    const controller = new AbortController();

    const response = await fetch(`${baseUrl}/assistant/askStream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'BX-2026-0003',
        question: '这张单子为什么被驳回了？',
      }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);

    // 等到**真的出了一个增量**再断：那时首字延迟已经发生过了，
    // 这条用例才能同时验证「首字算数、总耗时不算」。
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('event: delta')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('流在第一个增量之前就结束了，这条用例无从谈起');
      buffer += decoder.decode(value, { stream: true });
    }

    controller.abort();
    await reader.cancel().catch(() => undefined);

    const after = await waitFor(
      (snapshot) => snapshot.totals.aborted === before.totals.aborted + 1,
    );

    expect(after.totals.requests).toBe(before.totals.requests + 1);
    // 断开不是失败：它没有让任何人拿到一个错误，服务端也没有出错。
    expect(after.totals.ok).toBe(before.totals.ok);
    expect(after.totals.errors).toBe(before.totals.errors);
    // 用户确实看到过字 —— 首字延迟是真实观测。
    expect(after.ttftMs.samples).toBe(before.ttftMs.samples + 1);
    // 但总耗时被这次断开截断了，是个下界；混进延迟分布会把尾部拉得特别好看。
    expect(after.latencyMs.samples).toBe(before.latencyMs.samples);
  });
});
