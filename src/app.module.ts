import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { IpThrottlerGuard } from './ip-throttler.guard.js';
import { AssistantModule } from './modules/assistant/assistant.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    // 读项目根目录的 .env。
    //
    // isGlobal: true —— 每个模块（Prisma、LLM、assistant）都要读环境变量，
    // 设成全局就不必在每个模块里重复 import 一遍。
    //
    // ⚠️ 注意它只作用于**应用进程**。Prisma CLI 和 seed 是另外的进程，
    // 由 prisma.config.ts 里的 `import 'dotenv/config'` 负责加载。
    // 两者互不相干，改了 .env 两边都会生效，但原因不同 —— 别把其中一个当成另一个。
    //
    // 容器里没有 .env 文件，这里的值全部来自平台注入的环境变量；
    // 文件不存在不会报错，这正是想要的行为。
    ConfigModule.forRoot({ isGlobal: true }),

    /**
     * 限流。
     *
     * 为什么非有不可：这个服务要部署到公网，而 `/assistant/*` 每被调一次
     * 就要问一次模型。没有限流的话，一个循环脚本能在几分钟内把额度刷光 ——
     * 而且从日志上看和正常流量长得一模一样。
     *
     * 用 forRootAsync 而不是 forRoot：模块的元数据在**导入时**就求值了，
     * 那时 ConfigModule 还没把 .env 读进来，直接读 process.env 会拿到 undefined。
     * 走 useFactory 才能保证「配置已经就绪」再取值。
     */
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: 60_000,
          // 默认 30 次/分钟/IP。这是给演示用的宽松值：
          // 真人点着玩不会碰到，脚本刷就立刻撞墙。
          limit: Number(config.get('RATE_LIMIT_PER_MINUTE') ?? 30),
        },
      ],
    }),

    PrismaModule,
    AssistantModule,
  ],
  controllers: [AppController],
  providers: [
    // 注册成全局守卫，而不是逐个路由挂 @UseGuards。
    // 理由和 ValidationPipe 一样：**默认开启**才防得住「新加了一个端点，
    // 忘了给它加限流」。漏掉一个端点不会报错，只会安静地敞着。
    //
    // 用自己那个按 IP 统一计数的版本（见 ip-throttler.guard.ts）：
    // 库默认是按端点各算一份额度，那样两个模型端点加起来就是文档里那个数的两倍。
    { provide: APP_GUARD, useClass: IpThrottlerGuard },
  ],
})
export class AppModule {}
