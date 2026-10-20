import { ValidationPipe, type NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';

/**
 * 建应用时传给 Nest 的选项。
 *
 * 抽出来是为了让 `main.ts` 和优雅退出那条 e2e 用的是**同一份** ——
 * 测试里手抄一遍选项，测的就只是测试自己的配置。
 */
export const APP_OPTIONS: NestApplicationOptions = {
  /**
   * 收到 SIGTERM 时**不等待**活跃连接，直接销毁 socket。
   *
   * 默认行为是 `server.close()` 等所有活跃请求结束。普通接口几百毫秒，等得起；
   * SSE 不是 —— 它可能正跑着一次最长 4 轮的模型调用（每轮超时 30 秒）。
   * 平台不会等这么久：Docker 给 10 秒宽限期，到点 SIGKILL（退出码 137）。
   * 也就是说，默认行为恰好在**最需要优雅退出的那种场景**里失效。
   *
   * 实测（一条 10 秒的慢流，1.5 秒时发 SIGTERM）：默认行为下进程要等流跑完；
   * 打开这个选项后毫秒级退出，`收到退出信号，数据库连接已释放` 那行照样出现 ——
   * Nest 的执行顺序是先跑销毁钩子（`$disconnect`），再关 HTTP server。
   *
   * 代价写清楚：**在途的普通请求也会被切断**。这个项目认这个代价 —— 请求都很短，
   * 用户刷新重试就行。要在生产里做得更细，得「先停止接受新连接 → 给在途请求
   * 一个限时窗口 → 到点再强断」，那是另一层复杂度，不是一行选项。
   */
  forceCloseConnections: true,
};

/**
 * 全局配置。
 *
 * 单独抽出来是因为 **e2e 测试也要用同一份** —— 如果 main.ts 里配一套、
 * 测试里再手写一套，那测试测的是测试自己的配置，跟线上跑的不是一回事，
 * 而这种漂移不会有任何报错提示。
 */
export function applyGlobalSetup(app: NestExpressApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      // DTO 用 class 而不是 interface，就是为了让这里在运行时有东西可校验。
      // 三个开关各解决一件事：
      whitelist: true, // 去掉 DTO 里没声明的字段，不让它们流进 service
      forbidNonWhitelisted: true, // 多传字段直接 400，而不是悄悄忽略 —— 契约要能被打脸
      transform: true, // 把 plain object 实例化成 DTO 类，装饰器才生效、类型才真的对
    }),
  );

  // 那个演示页。挂在同一个进程上、同一个来源，所以前端调 /assistant/* 不涉及跨域 ——
  // 少一个 CORS 配置，就少一处「本地能通、线上 403」的可能。
  //
  // 路径基于 cwd 而不是 __dirname：容器里 WORKDIR 就是项目根，两者一致。
  // 用 __dirname 的话，编译前后（src/ 与 dist/）层级不同，得写两套。
  app.useStaticAssets(join(process.cwd(), 'public'));

  // ── 反向代理 ──
  //
  // 这个开关**默认关着**，而且必须由部署环境显式打开，原因是两个方向都会出事：
  //
  //   · 关着，但确实在代理后面：`req.ip` 永远是代理自己的地址，
  //     于是限流从「每个用户 30 次/分」变成「所有人共享 30 次/分」——
  //     第一个人刷满，后面的人全部 429。症状看着像服务挂了。
  //   · 开着，但并没有代理：任何人发一个 `X-Forwarded-For: <随机IP>` 就能
  //     给自己换一个新身份，限流形同虚设。
  //
  // 两个都不能靠猜，所以交给知道实情的人用环境变量说清楚。
  // 值是要信任的**跳数**：托管平台通常只有一层自己的代理，所以是 1。
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  }
}
