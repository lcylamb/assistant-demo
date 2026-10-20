import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { accessLogMiddleware, shouldLogAccess } from './access-log.js';

/**
 * 访问日志的边界。
 *
 * 这里钉的是一张「记 / 不记」的表，以及两个容易写错的时刻：
 * 断开时状态码还停在 200、`finish` 和 `close` 会先后各来一次。
 */
describe('访问日志', () => {
  interface FakeResponse extends EventEmitter {
    statusCode: number;
    writableFinished: boolean;
    getHeader(name: string): string | undefined;
  }

  function fakeResponse(
    options: {
      status?: number;
      finished?: boolean;
      contentType?: string;
    } = {},
  ): FakeResponse {
    const res = new EventEmitter() as unknown as FakeResponse;
    res.statusCode = options.status ?? 200;
    res.writableFinished = options.finished ?? true;
    res.getHeader = (name: string) =>
      name.toLowerCase() === 'content-type' ? options.contentType : undefined;
    return res;
  }

  function run(
    req: Pick<Request, 'method' | 'path'>,
    res: FakeResponse,
    emit: 'finish' | 'close' | 'both',
  ): void {
    accessLogMiddleware(
      req as Request,
      res as unknown as Response,
      () => undefined,
    );
    if (emit === 'finish' || emit === 'both') res.emit('finish');
    if (emit === 'close' || emit === 'both') res.emit('close');
  }

  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('业务接口的成功请求记一条，带方法、路径、状态码和耗时', () => {
    run(
      { method: 'POST', path: '/assistant/ask' },
      fakeResponse({ status: 200 }),
      'finish',
    );

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^POST \/assistant\/ask 200 \d+ms$/),
    );
  });

  it('探活和静态资源的成功请求不记 —— 否则日志里九成是它们', () => {
    run(
      { method: 'GET', path: '/health' },
      fakeResponse({ status: 200 }),
      'finish',
    );
    run({ method: 'GET', path: '/' }, fakeResponse({ status: 200 }), 'finish');
    run(
      { method: 'GET', path: '/app.css' },
      fakeResponse({ status: 200 }),
      'finish',
    );

    expect(log).not.toHaveBeenCalled();
  });

  it('失败不分路径：探活挂了、乱扫的 404 都要看见', () => {
    run(
      { method: 'GET', path: '/health' },
      fakeResponse({ status: 503 }),
      'finish',
    );
    run(
      { method: 'GET', path: '/nope' },
      fakeResponse({ status: 404 }),
      'finish',
    );

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^GET \/health 503 \d+ms$/),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^GET \/nope 404 \d+ms$/),
    );
  });

  it('客户端断开记成「客户端断开」，不照抄还停在 200 的状态码', () => {
    run(
      { method: 'POST', path: '/assistant/askStream' },
      fakeResponse({ status: 200, finished: false }),
      'close',
    );

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^POST \/assistant\/askStream 客户端断开 \d+ms$/),
    );
  });

  it('流式请求标出来 —— 它的耗时是整条流，不能和普通接口比', () => {
    run(
      { method: 'POST', path: '/assistant/askStream' },
      fakeResponse({ status: 200, contentType: 'text/event-stream' }),
      'finish',
    );

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^POST \/assistant\/askStream 200 \d+ms（流式）$/),
    );
  });

  it('finish 和 close 都会到，但只写一行', () => {
    run({ method: 'GET', path: '/assistant/metrics' }, fakeResponse(), 'both');

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('shouldLogAccess 的规则本身', () => {
    expect(shouldLogAccess('/assistant/ask', 200)).toBe(true);
    expect(shouldLogAccess('/health', 200)).toBe(false);
    expect(shouldLogAccess('/health', 500)).toBe(true);
  });
});
