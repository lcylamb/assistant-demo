import { ConsoleLogger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * 请求上下文：让同一次请求打出的每一行日志都能对上号。
 *
 * ── 为什么需要它 ──
 *
 * 日志本身已经写了单号，但那是**业务**上的键，不是请求的键：两个人同时问同一张单，
 * 两边的「工具 get_expense_summary 完成」「流式回答完成」会交错在一起，分不出谁是谁。
 * 出问题时能拿到的往往只有一句「我刚才问的时候很慢」—— 这时唯一的线索就是
 * 客户端看到的那个 id。
 *
 * ── 为什么用 AsyncLocalStorage ──
 *
 * 把 id 一路当参数传下去要穿过 controller、service、provider、工具层，每个函数签名
 * 都多一个和业务无关的东西；而日志是横切的，ALS 正好是这个形状。代价是隐式上下文，
 * 所以只用来做一件事：给日志加前缀。**业务逻辑不读它**。
 */
const storage = new AsyncLocalStorage<{ requestId: string }>();

export const REQUEST_ID_HEADER = 'x-request-id';

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

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/**
 * 给每个请求定一个 id，并写进响应头里。
 *
 * 沿用客户端传进来的 id 是有意的：前端或网关先编了一个、也想用自己的日志对上，
 * 我们再换一个就把线索切断了。**校验过**之后再沿用，见 `SAFE_ID`。
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id = normalizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  res.setHeader('X-Request-Id', id);
  runWithRequestId(id, next);
}

/**
 * 带请求 id 的日志。
 *
 * 只给**字符串**加前缀 —— 传进来一个对象或 Error 时保持原样，
 * 否则会改变 Nest 打印堆栈 / 结构化输出的行为。
 */
export class RequestIdLogger extends ConsoleLogger {
  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(stamp(message), ...optionalParams);
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(stamp(message), ...optionalParams);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(stamp(message), ...optionalParams);
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(stamp(message), ...optionalParams);
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(stamp(message), ...optionalParams);
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(stamp(message), ...optionalParams);
  }
}

function stamp(message: unknown): unknown {
  const id = currentRequestId();
  return id !== undefined && typeof message === 'string'
    ? `[req ${id}] ${message}`
    : message;
}
