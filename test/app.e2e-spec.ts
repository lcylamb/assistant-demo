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

  it('GET /health 活着', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('GET / 交给静态演示页，而不是 Nest 路由', async () => {
    // 静态中间件排在 Nest 的路由之前，所以 `/` 会被它接走。
    // 这条断言就是在钉住这个顺序 —— 哪天有人在 AppController 里加了个 @Get()，
    // 这里会立刻发现「首页被路由抢走了」。
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('报销单问答');
  });
});
