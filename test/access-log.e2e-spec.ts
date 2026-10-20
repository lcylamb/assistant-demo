import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';

/**
 * 访问日志 (e2e)。
 *
 * 单测用假的 req/res 钉住了「记不记」的规则，这里钉的是**接上真服务之后**的事：
 * 中间件的顺序对不对（拿不拿得到请求 id）、`finish` 在真实 socket 上何时触发、
 * 以及断开时到底是 finish 还是 close。
 *
 * 这里 spy 的是 `process.stdout.write` 而不是 `Logger.prototype.log` ——
 * 因为要验的恰好是**渲染后**的那一行：`RequestIdLogger` 加的前缀只在最后一步出现。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */
describe('访问日志 (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const lines: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  /** 日志在响应之后才写，给事件循环一点时间。 */
  async function waitForLine(
    predicate: (line: string) => boolean,
    timeoutMs = 2000,
  ): Promise<string> {
    const startedAt = Date.now();
    for (;;) {
      const found = lines.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`等不到那条日志，已收到的：\n${lines.join('')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('业务接口记一条、健康的探活不记', async () => {
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/assistant/metrics`);

    const metrics = await waitForLine((line) =>
      line.includes('GET /assistant/metrics 200'),
    );
    // 请求 id 是访问日志能和业务日志对上的唯一理由 —— 单独断言它。
    expect(metrics).toMatch(/\[req [A-Za-z0-9._:-]{8,64}\]/);
    expect(lines.some((line) => line.includes('GET /health'))).toBe(false);
  });

  it('扫描到的 404 也记 —— 它不在 /assistant 下，但失败了', async () => {
    await fetch(`${baseUrl}/nope`);

    const line = await waitForLine((text) => text.includes('GET /nope 404'));
    expect(line).toMatch(/\[req /);
  });

  it('流式请求标出「流式」，且和响应头里的 id 对得上', async () => {
    const response = await fetch(`${baseUrl}/assistant/askStream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'BX-2026-0003',
        question: '这张单子为什么被驳回了？',
      }),
    });
    const requestId = response.headers.get('x-request-id');
    // 把流读完，服务端才会走到 res.end() → finish。
    await response.text();

    const line = await waitForLine((text) =>
      text.includes('POST /assistant/askStream 200'),
    );
    expect(line).toContain('（流式）');
    expect(line).toContain(`[req ${requestId}]`);
  });

  it('客户端中途断开：记成「客户端断开」，不是一次成功的 200', async () => {
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
    const requestId = response.headers.get('x-request-id');

    // 读到第一个增量再断：那时响应头早已发出，状态码停在 200，
    // 所以「断开」只能靠 writableFinished 判出来。
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('event: delta')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('流在第一个增量之前就结束了，这条用例无从谈起');
      buffer += decoder.decode(value, { stream: true });
    }
    controller.abort();

    const line = await waitForLine((text) => text.includes('客户端断开'));
    expect(line).toContain('POST /assistant/askStream');
    expect(line).toContain(`[req ${requestId}]`);
  });
});
