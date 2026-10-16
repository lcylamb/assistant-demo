import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

@Controller()
export class AppController {
  /**
   * 探活。
   *
   * 原来这里是脚手架自带的 `GET /` 返回 Hello World，现在让给了静态的演示页
   * （`public/index.html`，由 app-setup.ts 里的 useStaticAssets 提供）——
   * 静态中间件跑在 Nest 路由之前，`/` 会被它先接走，留着那个 handler 只会
   * 变成一段永远不执行的代码。
   *
   * 而且 `/health` 本来就更该是它该在的位置：探活接口和首页共用一个路径，
   * 迟早会有人把首页当成健康检查。
   *
   * @SkipThrottle()：限流是全局默认开的（见 app.module.ts），这里必须显式豁免。
   * 因为探活的调用方**不是用户**，是平台的健康检查 —— 它按固定间隔自己打，
   * 和人多人少无关。而这类调用有个共同特征：一旦被 429，平台读到的是
   * 「不健康」，于是重启容器，重启后继续 429，直接进死循环。
   * 更要紧的是它根本不碰模型、不花钱，限流本来就没有防的东西。
   */
  @SkipThrottle()
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
