import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';

/**
 * 访问日志 (e2e)。
 *
 * 单测钉住的是「记不记、什么级别」；这里钉的是**接上真服务之后**才成立的东西：
 * 中间件顺序（pino-http 有没有拿到请求 id）、真实 socket 上 `close` 与 `finish`
 * 的先后、以及最终写出去的那行 JSON 里到底有哪些字段。
 *
 * 截获方式是 spy `process.stdout.write` —— 能成立的前提是 AppModule 把
 * pino 的输出流设成了 `process.stdout`（默认的 fd 直写会绕过它）。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */
describe('访问日志 (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const lines: string[] = [];

  interface LogRecord {
    level: number;
    msg: string;
    reqId?: string;
    req?: { id?: string; method?: string; url?: string };
    res?: { statusCode?: number };
    responseTime?: number;
    streaming?: boolean;
    aborted?: boolean;
    context?: string;
  }

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
  async function waitFor(
    predicate: (record: LogRecord) => boolean,
    timeoutMs = 2000,
  ): Promise<LogRecord> {
    const startedAt = Date.now();
    for (;;) {
      const found = records().find(predicate);
      if (found !== undefined) return found;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`等不到那条日志，已收到的：\n${lines.join('')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** 只认 pino 写出的 JSON 行；同一条 stdout 上还有别的输出。 */
  function records(): LogRecord[] {
    const parsed: LogRecord[] = [];
    for (const chunk of lines) {
      for (const line of String(chunk).split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const value = JSON.parse(line) as LogRecord;
          if (typeof value.msg === 'string') parsed.push(value);
        } catch {
          // 半行或非 JSON 输出：不是这个测试关心的东西。
        }
      }
    }
    return parsed;
  }

  it('业务接口记一条、健康的探活不记，且带请求 id', async () => {
    const metrics = await fetch(`${baseUrl}/assistant/metrics`);
    const requestId = metrics.headers.get('x-request-id');
    await metrics.text();
    await fetch(`${baseUrl}/health`);

    const record = await waitFor((entry) =>
      entry.msg.startsWith('GET /assistant/metrics 200'),
    );

    // 访问日志和响应头里的 id 必须一致 —— 它们存在的唯一意义就是对得上。
    expect(requestId).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(record.reqId).toBe(requestId);
    expect(record.req).toEqual({
      id: requestId,
      method: 'GET',
      url: '/assistant/metrics',
    });
    expect(record.res?.statusCode).toBe(200);
    expect(typeof record.responseTime).toBe('number');
    expect(record.streaming).toBe(false);
    expect(record.aborted).toBe(false);

    expect(records().some((entry) => entry.msg.startsWith('GET /health'))).toBe(
      false,
    );
  });

  it('扫描到的 404 也记 —— 它不在 /assistant 下，但失败了', async () => {
    await fetch(`${baseUrl}/nope`);

    const record = await waitFor((entry) =>
      entry.msg.startsWith('GET /nope 404'),
    );

    // 4xx 是客户端用错了，级别落在 warn（40）。
    expect(record.level).toBe(40);
    expect(record.reqId).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
  });

  it('流式请求标出「流式」，且只记一条', async () => {
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

    const record = await waitFor((entry) =>
      entry.msg.startsWith('POST /assistant/askStream 200'),
    );

    expect(record.streaming).toBe(true);
    expect(record.aborted).toBe(false);
    expect(record.reqId).toBe(requestId);
    expect(
      records().filter((entry) =>
        entry.msg.startsWith('POST /assistant/askStream '),
      ),
    ).toHaveLength(1);
  });

  it('业务日志带上同一个 reqId —— 这才是请求上下文的意义', async () => {
    const response = await fetch(`${baseUrl}/assistant/askStream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'BX-2026-0003',
        question: '这张单子为什么被驳回了？',
      }),
    });
    const requestId = response.headers.get('x-request-id');
    await response.text();

    const record = await waitFor(
      (entry) =>
        entry.context !== undefined &&
        entry.reqId === requestId &&
        entry.msg.length > 0,
    );

    expect(record.reqId).toBe(requestId);
  });

  it('客户端中途断开：记成 aborted，不是一次成功的 200', async () => {
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

    const record = await waitFor(
      (entry) => entry.aborted === true && entry.msg.includes('客户端断开'),
    );

    expect(record.msg).toContain('POST /assistant/askStream');
    expect(record.reqId).toBe(requestId);
    expect(record.res?.statusCode).toBe(200);
  });
});
