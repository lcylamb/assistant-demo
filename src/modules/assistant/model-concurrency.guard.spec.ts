import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type {
  AssistantMetricsService,
  RejectionReason,
} from './assistant-metrics.service.js';
import {
  ModelConcurrencyGuard,
  maxConcurrentAsks,
} from './model-concurrency.guard.js';

/**
 * 并发上限。
 *
 * 要钉三件事：超了要拒、响应结束/断开要把额度还回去、还回去只能还一次。
 * 最后那条最隐蔽 —— `finish` 和 `close` 都会触发，减两次的话上限就形同虚设。
 */
describe('并发上限', () => {
  const original = process.env.MAX_CONCURRENT_ASKS;

  /** 被记下来的拒绝原因。守卫不直接碰这个数组，断言的是「有没有记一笔」。 */
  const rejected: RejectionReason[] = [];
  const metrics = {
    recordRejection: (reason: RejectionReason) => rejected.push(reason),
  } as unknown as AssistantMetricsService;

  afterEach(() => {
    rejected.length = 0;
    if (original === undefined) delete process.env.MAX_CONCURRENT_ASKS;
    else process.env.MAX_CONCURRENT_ASKS = original;
  });

  function context(): { ctx: ExecutionContext; res: EventEmitter } {
    const res = new EventEmitter();
    const ctx = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ExecutionContext;
    return { ctx, res };
  }

  function call(guard: ModelConcurrencyGuard, ctx: ExecutionContext): void {
    guard.canActivate(ctx);
  }

  it('超过上限直接 429，消息能直接给用户看，并记一次拒绝', () => {
    process.env.MAX_CONCURRENT_ASKS = '1';
    const guard = new ModelConcurrencyGuard(metrics);
    const first = context();

    call(guard, first.ctx);
    // 放进来的请求不记拒绝：这个计数只回答「有多少请求被挡在门外」。
    expect(rejected).toEqual([]);

    let caught: unknown;
    try {
      call(guard, context().ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(429);
    expect((caught as HttpException).message).toContain('请稍后再试');
    // 被拒的请求进不了 service 的 `record()`，少了这一笔，指标就看不到压力。
    expect(rejected).toEqual(['concurrency']);
  });

  it('响应结束或断开都会释放额度，而且只释放一次', () => {
    process.env.MAX_CONCURRENT_ASKS = '1';
    const guard = new ModelConcurrencyGuard(metrics);
    const first = context();
    call(guard, first.ctx);

    // 正常结束时两个事件会先后到 —— 只该减一次。
    first.res.emit('finish');
    first.res.emit('close');

    // 能再进来一个；但只有**一个**，说明前面确实只还了一份。
    call(guard, context().ctx);
    expect(() => call(guard, context().ctx)).toThrow(HttpException);
  });

  it('客户端中途断开也会释放（只发 close、不发的 finish 的那种）', () => {
    process.env.MAX_CONCURRENT_ASKS = '1';
    const guard = new ModelConcurrencyGuard(metrics);
    const first = context();
    call(guard, first.ctx);

    first.res.emit('close');

    expect(() => call(guard, context().ctx)).not.toThrow();
  });

  it('0 表示关掉上限', () => {
    process.env.MAX_CONCURRENT_ASKS = '0';
    const guard = new ModelConcurrencyGuard(metrics);

    for (let i = 0; i < 50; i += 1) call(guard, context().ctx);
  });

  it('配置读不出来时回落默认值，而不是 NaN', () => {
    delete process.env.MAX_CONCURRENT_ASKS;
    expect(maxConcurrentAsks()).toBe(8);

    process.env.MAX_CONCURRENT_ASKS = 'abc';
    expect(maxConcurrentAsks()).toBe(8);
    process.env.MAX_CONCURRENT_ASKS = '-1';
    expect(maxConcurrentAsks()).toBe(8);

    process.env.MAX_CONCURRENT_ASKS = ' 3 ';
    expect(maxConcurrentAsks()).toBe(3);
    process.env.MAX_CONCURRENT_ASKS = '2.7';
    expect(maxConcurrentAsks()).toBe(2);
  });
});
