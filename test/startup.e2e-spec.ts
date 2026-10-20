import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';

/**
 * 数据库连不上时，服务应该**起不来**。
 *
 * ── 为什么要一条用例 ──
 *
 * 「启动就失败」是一个容易被当成坏事的决定：容器起不来，平台会反复重启。
 * 反过来（带病启动、把错误推迟到第一个请求）看起来更"优雅"，但它把一次明确的
 * 配置错误拆成了无数个 500，而且每一个 500 都长得像业务 bug。
 *
 * 这条用例盯的就是那个决定本身：把连接串指到一个没人监听的端口，`app.init()`
 * 必须直接拒绝，并且消息里说清楚是「连不上数据库」—— 否则运维看到的第一现场
 * 只是一句 `Error`，方向从一开始就错了。
 *
 * 不依赖真的数据库在不在：端口 1 上不会有任何东西。
 */
describe('启动时连不上数据库 (e2e)', () => {
  it('直接启动失败，而不是带病起来把错误推迟到第一个请求', async () => {
    const original = process.env.DATABASE_URL;
    // 127.0.0.1:1 —— 立刻 ECONNREFUSED，不用等超时。
    process.env.DATABASE_URL =
      'postgresql://demo:demo@127.0.0.1:1/nope?schema=public';

    let app: NestExpressApplication | undefined;
    try {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication<NestExpressApplication>();
      await expect(app.init()).rejects.toThrow(/连不上数据库/);
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;

      // init 失败后容器是半开状态，关一下，别把连接池留给下一个用例。
      await app?.close().catch(() => undefined);
    }
  });
});
