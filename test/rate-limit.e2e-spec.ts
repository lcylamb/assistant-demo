import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import type { MetricsSnapshot } from '../src/modules/assistant/assistant-metrics.service.js';

/**
 * 限流到底限的是什么。
 *
 * ── 为什么值得一条 e2e ──
 *
 * 限流的配置写在模块元数据里，读代码只能看出「有个 30」。真正会出错的是三件事：
 *   · 额度按**端点**算还是按 **IP** 算 —— 库默认是前者，两个模型端点加起来就是 60；
 *   · 被拒的请求有没有**在进入业务之前**就被挡住（挡住才省得下模型调用）；
 *   · 探活和指标有没有被误伤（它们被挡，受害的是平台和看指标的人）。
 *
 * 这三件都只能在真实 HTTP 上验，而且都不能靠「读一遍配置」确认。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */

/** 把额度压到 3：测「超了会怎样」，不是测默认值。默认 30 要打 31 次才碰得到。 */
const LIMIT = 3;

describe('限流 (e2e)', () => {
  let app: NestExpressApplication;

  const body = {
    code: 'BX-2026-0003',
    question: '这张单子为什么被驳回了？',
  };

  const ask = () =>
    request(app.getHttpServer()).post('/assistant/ask').send(body);

  const askStream = () =>
    request(app.getHttpServer()).post('/assistant/askStream').send(body);

  const metrics = async (): Promise<MetricsSnapshot> => {
    const response = await request(app.getHttpServer())
      .get('/assistant/metrics')
      .expect(200);
    return response.body as MetricsSnapshot;
  };

  beforeAll(async () => {
    // ThrottlerModule.forRootAsync 在模块初始化时才读配置，而 dotenv 不会覆盖
    // 已经存在的环境变量 —— 所以在这里设，应用读到的就是这个数。
    process.env.RATE_LIMIT_PER_MINUTE = String(LIMIT);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    await app.init();
  });

  afterAll(async () => {
    // 必须还原：这个变量要是漏到别的 e2e 文件里，它们会因为「打几个请求就被限流」而红，
    // 而那种红看起来会像是被测代码坏了。
    delete process.env.RATE_LIMIT_PER_MINUTE;
    await app.close();
  });

  it('两个模型端点共用一份额度，用完之后 429，且被拒的请求没有花掉模型调用', async () => {
    const before = await metrics();

    // 故意轮着打：如果额度是按端点各算一份（库的默认行为），
    // 下面第 4 个请求在 askStream 上只是第 2 次，会返回 200。
    await ask().expect(200);
    await askStream().expect(200);
    await ask().expect(200);

    await askStream().expect(429);
    await ask().expect(429);

    const after = await metrics();
    // 被拒的两个请求必须在**进入业务之前**就被挡住 —— 只有 metrics.requests 没涨，
    // 才能说明它们确实没有走到 prepare()、没有查库、更没有调模型。
    expect(after.totals.requests).toBe(before.totals.requests + LIMIT);
    expect(after.totals.ok).toBe(before.totals.ok + LIMIT);
    expect(after.totals.errors).toBe(before.totals.errors);
    // 被拒的两次也要看得见 —— 它们进不了 totals，只在这个账上。
    expect(after.rejections.rateLimit).toBe(before.rejections.rateLimit + 2);
  });

  it('探活和指标接口豁免 —— 它们不碰模型，被挡只会伤到平台和看指标的人', async () => {
    // 上面已经把模型端点的额度用光了。这两个接口要是还在同一个桶里，下面全都会 429。
    for (let i = 0; i < LIMIT * 4; i += 1) {
      await request(app.getHttpServer()).get('/health').expect(200);
      await metrics();
    }
  });
});
