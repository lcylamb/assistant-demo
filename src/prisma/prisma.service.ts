import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma 客户端。
 *
 * ⚠️ Prisma 7 和 5/6 有两处写法不同，照着老教程写会直接跑不起来：
 *
 *   1. 连接串不再从 schema 读，而是通过一个 **driver adapter**（`new PrismaPg`）传进来。
 *      构造时不给 adapter 会直接抛「Pass a driver adapter to the PrismaClient constructor」。
 *   2. 生成的 client 不在 `@prisma/client` 里了，在 `src/generated/prisma`，用相对路径 import。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
    });
  }

  /**
   * 启动时确认数据库真的连得上。
   *
   * ⚠️ 光调 `$connect()` 是**不够**的。换成 driver adapter 之后 `$connect()` 变成了
   * 纯粹的惰性初始化 —— 它不建立任何连接、也不校验可达性，数据库根本不在也照样「成功」。
   * 所以必须自己发一条 `select 1` 才能真正证伪。
   *
   * 连不上就让启动失败：没有数据库的接口没有一个能用，与其带病启动、把错误推迟到
   * 第一个请求，不如立刻停下并说清怎么办。
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    try {
      await this.$queryRaw`select 1`;
    } catch (error) {
      throw new Error(
        `连不上数据库：${error instanceof Error ? error.message : String(error)}\n` +
          '  起库：npm run db:up\n' +
          '  建表与造数：npm run db:migrate && npm run db:seed',
      );
    }
    this.logger.log('数据库已连接');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    // 打这一行是为了让优雅退出**可观测**。
    //
    // 否则「到底有没有走完 $disconnect」在日志里没有任何痕迹，而这条日志的有无
    // 正是排查「明明没有请求，数据库连接数却下不去」时的第一个分叉点：
    //   看得到 → 钩子跑了，连接是数据库那边回收慢；
    //   看不到 → 信号根本没到应用（最常见的原因：CMD 写成了 shell 形式，
    //            SIGTERM 被 shell 吃掉，node 从头到尾没收到）。
    this.logger.log('收到退出信号，数据库连接已释放');
  }
}
