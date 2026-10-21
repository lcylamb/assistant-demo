import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PINO_HTTP_OPTIONS,
  accessMessage,
  assignRequestId,
  normalizeRequestId,
  requestIdMiddleware,
  requestLogLevel,
  requestOutcome,
  shouldLogAccess,
} from './logging.js';

/**
 * 日志配置的单测。
 *
 * 两处值得钉死的地方：
 *   · 请求 id 的白名单 —— 这个值会原样进日志和响应头，而它的来源是不可信请求头。
 *   · 「记 / 不记」这张表 —— 多记一行是噪音，少记一行就查不到问题。
 *
 * 真正的输出（pino 怎么把这几个字段写成一行 JSON）由 `test/access-log.e2e-spec.ts` 验。
 */
describe('日志', () => {
  interface FakeResponse {
    statusCode: number;
    writableFinished: boolean;
    setHeader(name: string, value: string): void;
    getHeader(name: string): string | undefined;
  }

  function fakeResponse(
    options: {
      status?: number;
      finished?: boolean;
      contentType?: string;
    } = {},
  ): FakeResponse {
    const headers: Record<string, string> = {};
    return {
      statusCode: options.status ?? 200,
      writableFinished: options.finished ?? true,
      setHeader(name, value) {
        headers[name] = value;
      },
      getHeader(name) {
        return name.toLowerCase() === 'content-type'
          ? options.contentType
          : headers[name];
      },
    };
  }

  function fakeRequest(
    overrides: Partial<{
      method: string;
      url: string;
      headers: Record<string, unknown>;
      id: unknown;
    }> = {},
  ): IncomingMessage {
    return {
      method: 'GET',
      url: '/assistant/metrics',
      headers: {},
      id: undefined,
      ...overrides,
    } as unknown as IncomingMessage;
  }

  describe('请求 id', () => {
    it('形状安全的 id 原样接受', () => {
      expect(normalizeRequestId('abc-123_DEF.456:789')).toBe(
        'abc-123_DEF.456:789',
      );
      // 网关常在两边加空白，去掉就好。
      expect(normalizeRequestId('  abc12345  ')).toBe('abc12345');
    });

    it('太短、太长、带换行的一律拒掉', () => {
      // 太短没有唯一性；太长会把每一行日志挤得没法读。
      expect(normalizeRequestId('short')).toBeNull();
      expect(normalizeRequestId('a'.repeat(65))).toBeNull();

      // 换行能在日志里伪造成一整行 —— 这正是白名单存在的理由。
      expect(
        normalizeRequestId('abc12345\n收到退出信号，数据库连接已释放'),
      ).toBeNull();
      // 重复的请求头会以数组形式出现，不是我们认识的形状。
      expect(normalizeRequestId(['abc12345', 'other12345'])).toBeNull();
      expect(normalizeRequestId(undefined)).toBeNull();
    });

    it('合法 id 沿用，并写进响应头', () => {
      const req = fakeRequest({
        headers: { 'x-request-id': 'client-abc-123' },
      });
      const res = fakeResponse();

      const id = assignRequestId(req, res as unknown as ServerResponse);

      expect(id).toBe('client-abc-123');
      expect(req.id).toBe('client-abc-123');
      expect((res as unknown as ServerResponse).getHeader('X-Request-Id')).toBe(
        'client-abc-123',
      );
    });

    it('非法或缺失时生成新的，绝不回显原始值', () => {
      const req = fakeRequest({
        headers: { 'x-request-id': 'bad id with spaces' },
      });
      const res = fakeResponse();

      const id = assignRequestId(req, res as unknown as ServerResponse);

      expect(id).not.toBe('bad id with spaces');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect((res as unknown as ServerResponse).getHeader('X-Request-Id')).toBe(
        id,
      );
    });

    it('中间件不覆盖已有的 id', () => {
      const req = fakeRequest({ id: 'already-set-id', headers: {} });
      const res = fakeResponse();
      const next = vi.fn();

      requestIdMiddleware(req as never, res as unknown as never, next);

      // 两个入口各编一个 id 的话，响应头和日志里的 reqId 就对不上了。
      expect(req.id).toBe('already-set-id');
      expect(res.getHeader('X-Request-Id')).toBeUndefined();
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('访问日志的取舍', () => {
    it('shouldLogAccess 的规则本身', () => {
      expect(shouldLogAccess('/assistant/ask', 200)).toBe(true);
      expect(shouldLogAccess('/health', 200)).toBe(false);
      expect(shouldLogAccess('/health', 500)).toBe(true);
    });

    it('按路径和状态码给级别，不该记的返回 silent', () => {
      expect(requestLogLevel('/assistant/ask', 200, false)).toBe('info');
      // 探活和静态资源的成功请求不记 —— 否则日志里九成是它们。
      expect(requestLogLevel('/health', 200, false)).toBe('silent');
      expect(requestLogLevel('/', 200, false)).toBe('silent');
      // 失败不分路径：乱扫的 404、限流打回来的 429 都要看见。
      expect(requestLogLevel('/nope', 404, false)).toBe('warn');
      expect(requestLogLevel('/assistant/ask', 429, false)).toBe('warn');
      // 5xx 和抛了异常的请求，单独一级。
      expect(requestLogLevel('/health', 503, false)).toBe('error');
      expect(requestLogLevel('/assistant/ask', 502, false)).toBe('error');
      expect(requestLogLevel('/assistant/ask', 200, true)).toBe('error');
    });

    it('流式请求标出来 —— 它的耗时是整条流，不能和普通接口比', () => {
      const req = fakeRequest({ method: 'POST', url: '/assistant/askStream' });
      const res = fakeResponse({ contentType: 'text/event-stream' });

      expect(accessMessage(req, res as unknown as ServerResponse, 912)).toBe(
        'POST /assistant/askStream 200 912ms（流式）',
      );
    });

    it('客户端断开记成「客户端断开」，不照抄还停在 200 的状态码', () => {
      const req = fakeRequest({ method: 'POST', url: '/assistant/askStream' });
      const res = fakeResponse({ finished: false });

      const outcome = requestOutcome(res as unknown as ServerResponse);

      expect(outcome).toEqual({ streaming: false, aborted: true });
      expect(accessMessage(req, res as unknown as ServerResponse, 40)).toBe(
        'POST /assistant/askStream 客户端断开 40ms',
      );
    });

    it('日志里不含查询串 —— 只留「打的是哪个接口」', () => {
      const req = fakeRequest({ url: '/assistant/metrics?verbose=1' });

      expect(
        accessMessage(req, fakeResponse() as unknown as ServerResponse, 3),
      ).toBe('GET /assistant/metrics 200 3ms');
    });

    it('响应结束时把 streaming / aborted 作为字段带上', () => {
      const req = fakeRequest({ method: 'POST', url: '/assistant/askStream' });
      const res = fakeResponse({
        finished: false,
        contentType: 'text/event-stream',
      });

      const object = PINO_HTTP_OPTIONS.customSuccessObject?.(
        req,
        res as unknown as ServerResponse,
        { responseTime: 5 },
      );

      // 这两个字段只在响应结束时才有意义，所以必须由 customSuccessObject 加，
      // 不能放进 customProps（它在请求开始时就会先调一次）。
      expect(object).toMatchObject({
        responseTime: 5,
        streaming: true,
        aborted: true,
      });
    });

    it('customLogLevel 看的是最终状态码', () => {
      const level = PINO_HTTP_OPTIONS.customLogLevel;

      expect(
        level?.(fakeRequest({ url: '/health' }), fakeResponse() as never),
      ).toBe('silent');
      expect(
        level?.(
          fakeRequest({ url: '/nope' }),
          fakeResponse({ status: 404 }) as never,
        ),
      ).toBe('warn');
    });

    it('序列化器不把请求头写进日志', () => {
      const reqSerializer = PINO_HTTP_OPTIONS.serializers?.req as (
        req: unknown,
      ) => unknown;

      // 形状和 pino-std-serializers 交给我们的一致。
      const serialized = reqSerializer({
        id: 'req-12345678',
        method: 'GET',
        url: '/health',
        headers: { authorization: 'Bearer secret', cookie: 'sid=1' },
        remoteAddress: '127.0.0.1',
      });

      expect(serialized).toEqual({
        id: 'req-12345678',
        method: 'GET',
        url: '/health',
      });
    });
  });
});
