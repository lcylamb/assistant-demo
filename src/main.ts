import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_OPTIONS, applyGlobalSetup } from './app-setup.js';

async function bootstrap() {
  // 要 <NestExpressApplication> 这个泛型才能拿到 useStaticAssets ——
  // 它是 express 平台特有的，不在通用的 INestApplication 上。
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    APP_OPTIONS,
  );
  applyGlobalSetup(app);

  // 收到 SIGTERM / SIGINT 时走一遍生命周期钩子 —— PrismaService 的 $disconnect 在那里。
  //
  // 加它，是因为容器里这件事从「锦上添花」变成了必须：
  // `docker stop` 和滚动更新发的都是 SIGTERM，不接住的话进程直接被杀，
  // 连接池里的连接会悬着，直到数据库那边自己超时回收。
  // 单机跑看不出问题，连接数一多就是「明明没请求，连接数却下不去」。
  //
  // 光接住信号还不够：默认的 `server.close()` 会等活跃请求跑完，而 SSE 是长连接。
  // 那一步由 APP_OPTIONS 里的 `forceCloseConnections` 管着 —— 理由写在 app-setup.ts。
  //
  // 放在 main.ts 而不是 app-setup.ts：测试里不想要它 ——
  // 注册全局信号监听会影响 vitest 自己的退出流程。
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
