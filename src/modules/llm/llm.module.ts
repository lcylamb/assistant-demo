import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DailyQuotaService } from './daily-quota.service.js';
import { LLM_PROVIDER, type LlmProvider } from './llm.types.js';
import { MockLlmProvider } from './mock-llm.provider.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  OpenAiCompatibleProvider,
} from './openai-compatible.provider.js';

/**
 * LLM 模块。
 *
 * 这里是「换厂商」唯一需要动的地方 —— 业务代码注入的是 LLM_PROVIDER 令牌，
 * 拿到的是 LlmProvider 接口，不知道背后是谁。
 *
 * 两个取值：`mock`（默认，规则表，不需要任何密钥）和 `openai`
 * （任何说 OpenAI `/chat/completions` 协议的服务 —— 厂商由 LLM_BASE_URL + LLM_MODEL 决定）。
 *
 * ⚠️ 默认仍是 mock：仓库 clone 下来不配密钥也能跑起来、测试也能全绿。
 * 真模型是**显式选择**出来的，不是「配了就自动生效」。
 */
@Module({
  providers: [
    DailyQuotaService,
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: createLlmProvider,
    },
  ],
  exports: [LLM_PROVIDER, DailyQuotaService],
})
export class LlmModule {}

/**
 * 按配置造 provider。
 *
 * 单独导出而不是匿名写在 `useFactory` 里：这里的三条「宁可起不来」的规则
 * （未知 provider、缺密钥、数字配置写错）都值得有测试，而匿名工厂只能在
 * 起一整个 Nest 容器之后才摸得到 —— 为了测三个分支搭一个容器，不值得。
 */
export function createLlmProvider(config: ConfigService): LlmProvider {
  const kind = config.get<string>('LLM_PROVIDER') ?? 'mock';

  switch (kind) {
    case 'mock':
      return new MockLlmProvider();

    case 'openai':
      return new OpenAiCompatibleProvider({
        apiKey: config.get<string>('LLM_API_KEY') ?? '',
        baseUrl: config.get<string>('LLM_BASE_URL') ?? '',
        model: config.get<string>('LLM_MODEL') ?? '',
        timeoutMs: positive(config, 'LLM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
        maxAttempts: positive(config, 'LLM_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
        maxTokens: positive(config, 'LLM_MAX_TOKENS', DEFAULT_MAX_TOKENS),
        // 默认开。要关掉是显式写 false，不是「没配就关」——
        // 对结构化输出这个项目来说，约束开着才是正常状态。
        jsonMode: config.get<string>('LLM_JSON_MODE') !== 'false',
        // 同上：默认让厂商在流末尾报用量。少数兼容实现不认这个字段，用 false 关掉。
        streamUsage: config.get<string>('LLM_STREAM_USAGE') !== 'false',
      });

    default:
      // 不认识的取值直接让启动失败，不要悄悄退回 mock ——
      // 「以为接了真模型、其实一直在跑假数据」是最坏的一种失败。
      throw new Error(
        `不支持的 LLM_PROVIDER：${kind}。当前只有 'mock' 和 'openai'。`,
      );
  }
}

/**
 * 读一个正整数配置。
 *
 * 写错了**在启动时炸**，不退回默认值 —— 和上面 default 分支同一条原则：
 * 「我明明设了 20 秒超时」和「它其实一直在用 30 秒」之间的差别，
 * 在排查线上问题时是几个小时的差距。宁可起不来。
 */
function positive(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} 必须是一个正数，当前值：${raw}`);
  }
  return Math.floor(value);
}
