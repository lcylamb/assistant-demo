import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller.js';
import type { PrismaService } from './prisma/prisma.service.js';

/**
 * 探活接口的三个状态：库在、库报错、库不响应。
 *
 * 第三个是重点。前两个用 e2e 也能测，但「不响应」在 e2e 里要么等两秒、
 * 要么把超时调小 —— 两种都会让测试变慢或变脆。这里直接把 `$queryRaw`
 * 换成一个永远不 resolve 的 promise，再用假定时器把时间推过去。
 *
 * 这个状态之所以值得一条用例：库以「连接被黑洞」的方式挂掉时，查询不会报错，
 * 它会一直挂着。没有上限的话，探针自己先超时，平台看到的是「没响应」而不是
 * 「库不可用」—— 而这两件事的下一步动作完全不同。
 */

function controllerWith(queryRaw: () => Promise<unknown>): AppController {
  return new AppController({ $queryRaw: queryRaw } as unknown as PrismaService);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AppController（探活）', () => {
  it('库可达 → 200，并且真的查了一次', async () => {
    const queryRaw = vi.fn(async () => [{ '?column?': 1 }]);
    const controller = controllerWith(queryRaw);

    await expect(controller.health()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('库连不上 → 503，body 里写清楚是哪一层挂了', async () => {
    // 日志单独断言：探针失败的那条 warn 是「库从什么时候开始连不上」的时间线。
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const controller = controllerWith(async () => {
      throw new Error("Can't reach database server");
    });

    const error = await controller.health().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    // 状态码 503 已经说明了「暂时不可用」；body 里再分出 `db: down`，
    // 是为了让「进程死了」和「库死了」在调用方那里也能区分。
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      db: 'down',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('数据库不可用'));
  });

  it('库不响应 → 到点就返回 503，不会一直挂着', async () => {
    vi.useFakeTimers();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const controller = controllerWith(() => new Promise(() => undefined));
    const pending = controller.health().catch((caught: unknown) => caught);

    // 断言提前挂上，避免假定时器推进时出现「未处理的 rejection」。
    const assertion = expect(pending).resolves.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('探活超时'));
  });
});
