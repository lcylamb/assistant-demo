import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { applyGlobalSetup } from './../src/app-setup.js';

describe('应用外壳 (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    // 和 main.ts 用同一个函数 —— 否则这里测的是测试自己的配置。
    applyGlobalSetup(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health 活着，并且数据库真的可达', async () => {
    // `db: 'ok'` 不是装饰：这条路由会真的发一条 `select 1`，
    // 「进程活着」和「服务能用」在这个项目里是同一个问题（见 app.controller.ts）。
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('GET / 交给静态演示页，而不是 Nest 路由', async () => {
    // 静态中间件排在 Nest 的路由之前，所以 `/` 会被它接走。
    // 这条断言就是在钉住这个顺序 —— 哪天有人在 AppController 里加了个 @Get()，
    // 这里会立刻发现「首页被路由抢走了」。
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('报销单问答');
  });

  it('每个响应都带 X-Request-Id；客户端带来的合法 id 会沿用', async () => {
    // 生成：没有传的时候必须有一个，否则「用户报了一个 id」这件事根本无从发生。
    const generated = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(generated.headers['x-request-id']).toMatch(
      /^[A-Za-z0-9._:-]{8,64}$/,
    );

    // 沿用：网关或前端先编了一个 id，我们再换一个就把两边的日志切断了。
    const echoed = await request(app.getHttpServer())
      .get('/health')
      .set('X-Request-Id', 'client-abc-12345')
      .expect(200);
    expect(echoed.headers['x-request-id']).toBe('client-abc-12345');

    // 不合法：这个值会进日志和响应头，所以带空格/换行的必须换掉，不能原样回显。
    const rejected = await request(app.getHttpServer())
      .get('/health')
      .set('X-Request-Id', 'bad id with spaces')
      .expect(200);
    expect(rejected.headers['x-request-id']).not.toBe('bad id with spaces');
    expect(rejected.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
  });
});
