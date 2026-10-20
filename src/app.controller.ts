import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from './prisma/prisma.service.js';

/**
 * 探活时给数据库最多多少毫秒。
 *
 * 必须比调用方的超时短。Dockerfile 的 HEALTHCHECK 是 `--timeout=3s`，
 * 平台自己的探针一般也在这个量级 —— 如果这里不设上限，库以「连接被黑洞」的方式
 * 挂掉时，`select 1` 会一直挂到驱动自己的连接超时，探针先到点，看到的是「没响应」，
 * 而不是我们想告诉它的「库不可用」。2s 留出 1s 给网络和序列化。
 */
const DB_PING_TIMEOUT_MS = 2000;

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(private readonly prisma: PrismaService) {}

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
   * ── 为什么要真的查一次库 ──
   *
   * 「进程还在、端口还开着」不等于「这个服务还能用」。这个服务的每一条业务路径
   * 都要读库，库连不上时它能做的只有 503。探活如果只回一句 `ok`，
   * 平台看到的永远是健康，既不会把实例摘掉，也不会提醒任何人 ——
   * 症状是「监控全绿，用户全在报错」。所以这里发一条 `select 1`，
   * 和启动时那道检查（`PrismaService.onModuleInit`）用同一个证伪手段。
   *
   * 代价要说清楚：库挂掉时探活会失败，平台于是重启实例，而实例启动时又要求库可达
   * （见 onModuleInit）—— 库没恢复之前会反复重启。这是有意选的：一个读不了数据的
   * 实例对用户没有价值，反复重启至少让「它不健康」这件事一眼可见。
   *
   * @SkipThrottle()：限流是全局默认开的（见 app.module.ts），这里必须显式豁免。
   * 因为探活的调用方**不是用户**，是平台的健康检查 —— 它按固定间隔自己打，
   * 和人多人少无关。而这类调用有个共同特征：一旦被 429，平台读到的是
   * 「不健康」，于是重启容器，重启后继续 429，直接进死循环。
   * 更要紧的是它不碰模型、不花钱，限流本来就没有防的东西。
   */
  @SkipThrottle()
  @Get('health')
  async health(): Promise<{ status: 'ok'; db: 'ok' }> {
    if (!(await this.pingDatabase())) {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }

    return { status: 'ok', db: 'ok' };
  }

  /**
   * 发一条 `select 1`，最多等 `DB_PING_TIMEOUT_MS`。
   *
   * 用 `Promise.race` 而不是给驱动配超时：连接串是部署方给的，不该为了探活
   * 反过来要求它带一个参数。超时后查询本身还会在后台跑完 —— 那是连接池的事，
   * 这里只负责不让探针挂住。
   */
  private async pingDatabase(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.prisma.$queryRaw`select 1`,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('探活超时')),
            DB_PING_TIMEOUT_MS,
          );
        }),
      ]);
      return true;
    } catch (error) {
      // 每次探针失败记一条：这是「库从什么时候开始连不上」的唯一时间线。
      // 平台那边的「不健康」是结果，不是原因。
      this.logger.warn(
        `健康检查：数据库不可用（${error instanceof Error ? error.message : String(error)}）`,
      );
      return false;
    } finally {
      // 不清理的话，每次成功的探活都会留下一个 2s 的定时器 ——
      // 它不影响结果，但会让进程在退出时多等一会儿、测试里也会拖着线程。
      clearTimeout(timer);
    }
  }
}
