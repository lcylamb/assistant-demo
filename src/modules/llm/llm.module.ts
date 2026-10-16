import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDER, type LlmProvider } from './llm.types.js';
import { MockLlmProvider } from './mock-llm.provider.js';

/**
 * LLM 模块。
 *
 * 这里是「换厂商」唯一需要动的地方 —— 业务代码注入的是 LLM_PROVIDER 令牌，
 * 拿到的是 LlmProvider 接口，不知道背后是谁。
 *
 * 现在只有 mock 一个选项。接真实厂商时在这里加一个 case，
 * 其余代码一行不用改 —— 这就是把接口和实现分开的全部回报。
 */
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LlmProvider => {
        const kind = config.get<string>('LLM_PROVIDER') ?? 'mock';

        switch (kind) {
          case 'mock':
            return new MockLlmProvider();

          default:
            // 不认识的取值直接让启动失败，不要悄悄退回 mock ——
            // 「以为接了真模型、其实一直在跑假数据」是最坏的一种失败。
            throw new Error(
              `不支持的 LLM_PROVIDER：${kind}。当前只有 'mock'。` +
                '（接真实厂商时在 llm.module.ts 里加一个 case。）',
            );
        }
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
