import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DailyQuotaService } from './daily-quota.service.js';

/**
 * 每日总额度闸的单测。
 *
 * ── 为什么它值得单独测 ──
 *
 * 这个服务不产生任何用户可见的输出：它只在第 N+1 次调用时返回 false。
 * 写错了不会报错，只会**安静地**多放一批请求过去 —— 而那批请求花的是真钱。
 * 两个容易错的地方：
 *
 *   · 日界。计数如果永远不清零，服务跑过第一天之后就再也不接受请求了；
 *     清得太早（比如按本地时区或按小时），额度又会变成「每天不止一次」。
 *   · 「关闭」必须真的是关闭。0 / 没配 / 配错，三种情况都该放行；
 *     否则一次配置笔误就能让整个服务在部署后拒绝所有请求。
 *
 * 需要假时钟：真实时间跑不了「跨天」。
 */
function makeQuota(limit?: string): DailyQuotaService {
  const config = {
    get: (key: string) => (key === 'LLM_DAILY_LIMIT' ? limit : undefined),
  } as unknown as ConfigService;
  return new DailyQuotaService(config);
}

/** 连续调用 n 次，返回每次是否放行。 */
function consumeMany(quota: DailyQuotaService, n: number): boolean[] {
  return Array.from({ length: n }, () => quota.consume());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
  // 用满额度会打一条 warn，测试输出里不需要它。
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DailyQuotaService', () => {
  it('没配 / 配 0 / 配成非法值 → 关闭，永远放行', () => {
    for (const limit of [undefined, '0', 'abc', '-5', 'NaN']) {
      expect(consumeMany(makeQuota(limit), 5), `limit=${limit}`).toEqual(
        Array(5).fill(true),
      );
    }
  });

  it('配了 N → 恰好放行 N 次，第 N+1 次开始拒绝', () => {
    const quota = makeQuota('3');

    expect(consumeMany(quota, 5)).toEqual([true, true, true, false, false]);
  });

  it('小数向下取整 —— 额度不能是「2.9 次」', () => {
    expect(consumeMany(makeQuota('2.9'), 4)).toEqual([true, true, false, false]);
  });

  it('UTC 日界一过就重置', () => {
    const quota = makeQuota('2');

    expect(consumeMany(quota, 3)).toEqual([true, true, false]);

    // 同一天的最后一刻仍然拒绝。
    vi.setSystemTime(new Date('2026-10-21T23:59:59Z'));
    expect(quota.consume()).toBe(false);

    // 跨过 UTC 00:00 才是新的一天。这是国内用户的早上 8 点 ——
    // 不自然，但「按哪个时区算一天」必须有一个确定的答案。
    vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
    expect(quota.consume()).toBe(true);
  });

  it('用满那一刻只留一条日志，之后拒绝时不再刷', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const quota = makeQuota('2');

    consumeMany(quota, 10);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 次'));
  });

  it('被拒绝的调用不占用计数 —— 否则日界重置前的行为会取决于刷子', () => {
    const quota = makeQuota('2');

    consumeMany(quota, 100); // 其中 98 次被拒
    vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));

    // 新的一天仍然从 0 开始，额度没有被那 98 次拒绝撑大。
    expect(consumeMany(quota, 3)).toEqual([true, true, false]);
  });
});
