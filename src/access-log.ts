import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { currentRequestId, runWithRequestId } from './request-context.js';

/**
 * 访问日志：每个请求结束时留一行「谁、打哪、结果、多久」。
 *
 * ── 为什么在有了请求 id 之后还要这个 ──
 *
 * 请求 id 只是把**已有**的日志串起来。而业务日志是稀疏的：一次成功的提问
 * 可能一行都不打，于是「9:41 那次很慢」在日志里根本没有对应的一行。
 * 访问日志补的就是这个空档 —— 而且它是**唯一**知道「这次请求花了多久」的地方
 * （业务打点只记模型侧，不含排队、序列化和客户端读取的时间）。
 *
 * ── 为什么不是全量 ──
 *
 * 静态资源和探活是高频噪音：平台每 30 秒打一次 `/health`，一天的日志里
 * 九成都是它。所以只记 `/assistant/*` 的成功请求，以及**任何**路径上的失败
 * （4xx/5xx 不分路径 —— 404 扫描、限流打回来的请求恰恰是需要看见的）。
 */

const logger = new Logger('HTTP');

/** 记哪些路径：业务接口全记，其余只在失败时记。 */
export function shouldLogAccess(path: string, statusCode: number): boolean {
  return path.startsWith('/assistant') || statusCode >= 400;
}

export function accessLogMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startedAt = process.hrtime.bigint();
  // 在中间件里就把 id 抓住。`finish`/`close` 未必在请求的异步上下文里触发，
  // 而日志前缀靠的是 AsyncLocalStorage —— 不显式带一次，访问日志就会是
  // 唯一一种「有 id 却印不出来」的日志。
  const requestId = currentRequestId();
  let written = false;

  const write = (): void => {
    if (written) return;
    written = true;

    // 客户端提前断开时 `finish` 不会触发，`close` 会 —— 但状态码还停在 200，
    // 照抄它会把一次中断记成成功。`writableFinished` 才是「写完了」的判据。
    const aborted = !res.writableFinished;
    if (!shouldLogAccess(req.path, res.statusCode)) return;

    const elapsedMs = Math.round(
      Number(process.hrtime.bigint() - startedAt) / 1e6,
    );
    const outcome = aborted ? '客户端断开' : String(res.statusCode);
    // 流式的耗时是**整条流**的，和普通请求的「一次往返」不是一个量级 ——
    // 标出来，免得看日志的人拿它去和别的接口比。
    const streaming = String(res.getHeader('content-type') ?? '').includes(
      'text/event-stream',
    );
    const message = `${req.method} ${req.path} ${outcome} ${elapsedMs}ms${
      streaming ? '（流式）' : ''
    }`;

    if (requestId === undefined) {
      logger.log(message);
    } else {
      runWithRequestId(requestId, () => logger.log(message));
    }
  };

  // 两个事件都要挂：正常结束走 finish，断开走 close。write 自己保证只写一次。
  res.on('finish', write);
  res.on('close', write);
  next();
}
