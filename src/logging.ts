import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { LevelWithSilent } from 'pino';
import type { Options } from 'pino-http';

/**
 * 日志：请求 id、访问日志、结构化输出。
 *
 * ── 为什么用 pino ──
 *
 * 这里的日志是要被机器读的：平台收走 stdout 之后，排查靠的是按字段过滤，
 * 不是肉眼翻文本。一行 JSON 里带着 `reqId`、`statusCode`、`responseTime`，
 * 才能回答「9:41 那次提问为什么慢」这种问题。手写 `[req xxx]` 前缀也能对号，
 * 但要对号完之后再看耗时、状态码，就得回去解析字符串了。
 *
 * ── 谁负责什么 ──
 *
 * · `requestIdMiddleware`：在**任何**响应之前定下 id（包括静态页）。
 *   它必须排在静态资源前面，因为 `useStaticAssets` 注册得比 Nest 的模块中间件早，
 *   只靠 pino-http 的话，首页那个 HTML 响应就带不上 `X-Request-Id`。
 * · pino-http（由 LoggerModule 挂载）：给每个请求开 AsyncLocalStorage 上下文，
 *   访问日志、业务日志因此自动带上 `reqId`；它读到 `req.id` 之后直接沿用。
 * · `app.useLogger`：把 Nest 的全局 Logger 换成 pino 实现，模块里的
 *   `new Logger(...)` 全部落到 JSON 输出上。
 */

export const REQUEST_ID_HEADER = 'x-request-id';
const RESPONSE_REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * 只收白名单字符、限定长度。
 *
 * 这个值有两个去处：**日志**和**响应头**。原样信任一个客户端传来的字符串，
 * 等于让人往日志里注入换行（伪造出一整行「收到退出信号」并不难），
 * 或者往响应头里塞别的头。校验不是为了好看，是这两个去处决定的。
 *
 * 太短的 id 在排查时没有唯一性，太长的会把每一行日志挤得没法读。
 */
const SAFE_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export function normalizeRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return SAFE_ID.test(trimmed) ? trimmed : null;
}

/** 路径不含查询串 —— 日志里只留「打的是哪个接口」。 */
function pathOf(req: Pick<IncomingMessage, 'url'>): string {
  const url = req.url ?? '/';
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * 记哪些路径：业务接口全记，其余只在失败时记。
 *
 * 静态资源和探活是高频噪音：平台每 30 秒打一次 `/health`，一天的日志里
 * 九成都是它。所以只记 `/assistant/*` 的成功请求，以及**任何**路径上的失败
 * （4xx/5xx 不分路径 —— 404 扫描、限流打回来的请求恰恰是需要看见的）。
 */
export function shouldLogAccess(path: string, statusCode: number): boolean {
  return path.startsWith('/assistant') || statusCode >= 400;
}

/**
 * 访问日志的级别，`'silent'` 表示这条不记。
 *
 * 用 `customLogLevel` 而不是 `autoLogging.ignore`：后者只看请求、不看最终状态码，
 * 而且只对成功请求生效 —— 它没法表达「这个路径成功了不记、失败了要记」。
 */
export function requestLogLevel(
  path: string,
  statusCode: number,
  failed: boolean,
): LevelWithSilent {
  if (!shouldLogAccess(path, statusCode)) return 'silent';
  // 5xx 是服务端的问题，值得在日志里单独筛出来；4xx 是客户端用错了，降一级。
  if (failed || statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

export interface RequestOutcome {
  /** 响应是 SSE —— 它的耗时是整条流，不能和普通接口比。 */
  streaming: boolean;
  /** 客户端在响应写完之前断开。 */
  aborted: boolean;
}

export function requestOutcome(res: ServerResponse): RequestOutcome {
  const contentType = String(res.getHeader('content-type') ?? '');
  return {
    streaming: contentType.includes('text/event-stream'),
    // 断开时 `finish` 不触发、`close` 会，但状态码还停在 200。
    // 照抄状态码会把一次中断记成成功，`writableFinished` 才是「写完了」的判据。
    aborted: !res.writableFinished,
  };
}

export function accessMessage(
  req: IncomingMessage,
  res: ServerResponse,
  responseTime: number,
): string {
  const outcome = requestOutcome(res);
  const result = outcome.aborted ? '客户端断开' : String(res.statusCode);
  return `${req.method} ${pathOf(req)} ${result} ${responseTime}ms${
    outcome.streaming ? '（流式）' : ''
  }`;
}

/**
 * 定 id 并写响应头。
 *
 * 沿用客户端传进来的 id 是有意的：前端或网关先编了一个、也想用自己的日志对上，
 * 我们再换一个就把线索切断了。**校验过**之后再沿用，见 `SAFE_ID`。
 */
export function assignRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const id = normalizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  req.id = id;
  res.setHeader(RESPONSE_REQUEST_ID_HEADER, id);
  return id;
}

/**
 * 必须排在静态资源之前，理由见文件头。
 *
 * 已经有 id 就不动：pino-http 也挂在同一条链上，两边各编一个的话，
 * 响应头里的 id 和日志里的 `reqId` 就会对不上 —— 而它们存在的唯一意义就是对得上。
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.id === undefined) assignRequestId(req, res);
  next();
}

/**
 * pino-http 的配置。
 *
 * 几处不显然的地方：
 *
 * · `genReqId` 平时不会被调到 —— `requestIdMiddleware` 已经先定好了 id。
 *   留着它是为了「万一中间件没挂上」时仍然有 id，而不是拿到 `undefined`。
 * · `customSuccessObject` / `customErrorObject` 只在响应结束时调用，
 *   `aborted` 这种随响应变化的字段才能放这里；放进 `customProps` 会被请求开始时
 *   的那次调用提前定格成 `false`。
 * · `quietReqLogger: true`：请求内的业务日志只绑 `reqId`，不重复整份请求；
 *   访问日志自己那一条仍然带完整的 `req`（只留 id / method / url）。
 * · 序列化器只挑白名单字段。默认的 req 序列化器会把**全部请求头**写进日志，
 *   其中就包括 `Authorization` 和 Cookie。
 */
export const PINO_HTTP_OPTIONS: Options = {
  level: 'info',

  genReqId: assignRequestId,

  quietReqLogger: true,

  customLogLevel: (req, res, error) =>
    requestLogLevel(pathOf(req), res.statusCode, error !== undefined),

  customSuccessObject: (_req, res, value) => ({
    ...value,
    ...requestOutcome(res),
  }),

  customErrorObject: (_req, res, _error, value) => ({
    ...value,
    ...requestOutcome(res),
  }),

  customSuccessMessage: accessMessage,

  // 类型声明里没有第 4 个参数，但运行时会把 responseTime 传进来 ——
  // 错误日志同样需要耗时，所以接住它（声明成可选，才和上面的签名兼容）。
  customErrorMessage: (
    req: IncomingMessage,
    res: ServerResponse,
    _error: Error,
    responseTime?: number,
  ) => accessMessage(req, res, responseTime ?? 0),

  serializers: {
    req: (req: { id?: unknown; method?: string; url?: string }) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
    res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
  },
};
