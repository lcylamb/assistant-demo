import type { ConfigService } from '@nestjs/config';
import { createLlmProvider } from './llm.module.js';
import { MockLlmProvider } from './mock-llm.provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible.provider.js';

/**
 * provider 工厂的配置校验。
 *
 * 这几条规则有一个共同点：它们只在**启动时**生效，一旦写错，最坏的结果不是报错，
 * 而是「以为接了真模型，其实一直在跑规则表」—— 所有测试照样绿、所有答案照样像模像样。
 * 所以每一条都必须以「启动失败」收场，而且错误里要点名是哪个变量。
 *
 * 直接调工厂，不搭 Nest 容器：这三个分支和容器没有关系，搭容器只会让测试更慢、
 * 更像是「框架在测框架」。
 */
function makeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const OPENAI = {
  LLM_PROVIDER: 'openai',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: 'https://example.invalid/v1',
  LLM_MODEL: 'test-model',
};

describe('createLlmProvider', () => {
  it('没配 LLM_PROVIDER → 默认 mock（仓库 clone 下来就能跑）', () => {
    expect(createLlmProvider(makeConfig())).toBeInstanceOf(MockLlmProvider);
  });

  it("显式 'mock' → 规则表", () => {
    expect(
      createLlmProvider(makeConfig({ LLM_PROVIDER: 'mock' })),
    ).toBeInstanceOf(MockLlmProvider);
  });

  it("'openai' + 三项必填 → 真 provider", () => {
    expect(createLlmProvider(makeConfig(OPENAI))).toBeInstanceOf(
      OpenAiCompatibleProvider,
    );
  });

  it('不认识的取值 → 启动失败，不悄悄退回 mock', () => {
    expect(() =>
      createLlmProvider(makeConfig({ LLM_PROVIDER: 'deepseek' })),
    ).toThrow(/不支持的 LLM_PROVIDER：deepseek/);
  });

  it('openai 缺密钥 / 地址 / 模型 → 启动失败，并点名缺哪个', () => {
    for (const missing of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']) {
      const values = { ...OPENAI, [missing]: '' };
      expect(() => createLlmProvider(makeConfig(values)), missing).toThrow(missing);
    }
  });

  it('超时 / 输出上限 / 重试次数不是正数 → 启动失败，不退回默认值', () => {
    expect(() =>
      createLlmProvider(makeConfig({ ...OPENAI, LLM_TIMEOUT_MS: 'abc' })),
    ).toThrow(/LLM_TIMEOUT_MS/);

    expect(() =>
      createLlmProvider(makeConfig({ ...OPENAI, LLM_MAX_TOKENS: '0' })),
    ).toThrow(/LLM_MAX_TOKENS/);

    // 0 次尝试没有意义，写成 1 才是「关掉重试」。
    expect(() =>
      createLlmProvider(makeConfig({ ...OPENAI, LLM_MAX_ATTEMPTS: '0' })),
    ).toThrow(/LLM_MAX_ATTEMPTS/);
  });
});
