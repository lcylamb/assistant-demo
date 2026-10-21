import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { LlmProvider } from '../llm/llm.types.js';
import {
  AssistantMetricsService,
  type RequestMeasurement,
} from './assistant-metrics.service.js';

/**
 * 打点聚合的单测。
 *
 * 这里测的是**聚合口径**，不是「有没有记下来」：哪些请求进延迟分布、
 * 缺用量的请求怎么算、百分位取的是不是真实观测值。这些错了不会报错，
 * 只会安静地给出一组看起来正常的错误数字 —— 而打点的全部价值就是那几个数字。
 */

function makeMetrics(values: Record<string, string> = {}): AssistantMetricsService {
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new AssistantMetricsService({ name: 'mock' } as LlmProvider, config);
}

function measurement(overrides: Partial<RequestMeasurement> = {}): RequestMeasurement {
  return {
    outcome: 'ok',
    elapsedMs: 100,
    ttftMs: null,
    modelCalls: 2,
    toolCalls: 1,
    toolMs: 10,
    usage: { promptTokens: 100, completionTokens: 20 },
    ...overrides,
  };
}

beforeEach(() => {
  // 每个请求一行日志会把测试输出淹掉；这层日志本身在下面有一条单独的断言。
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AssistantMetricsService', () => {
  it('一次请求都没有时：全是 0 / null，不编成本', () => {
    const snapshot = makeMetrics().snapshot();

    expect(snapshot.totals.requests).toBe(0);
    expect(snapshot.latencyMs).toEqual({
      samples: 0,
      p50: null,
      p95: null,
      max: null,
      avg: null,
    });
    expect(snapshot.cost).toBeNull();
    // 报出来的 provider 是实际在答的那个，不是猜的。
    expect(snapshot.provider).toBe('mock');
  });

  it('被拒绝的请求按原因分开计数，且不混进 totals', () => {
    const metrics = makeMetrics();
    metrics.recordRejection('rateLimit');
    metrics.recordRejection('rateLimit');
    metrics.recordRejection('concurrency');
    metrics.recordRejection('quota');

    const snapshot = metrics.snapshot();

    expect(snapshot.rejections).toEqual({
      rateLimit: 2,
      concurrency: 1,
      quota: 1,
    });
    // 它们连 service 都没进：算进 requests 会让错误率和平均耗时一起失真。
    expect(snapshot.totals.requests).toBe(0);
    expect(snapshot.latencyMs.samples).toBe(0);
  });

  it('成功、失败、取消分开记；取消不进延迟分布', () => {
    const metrics = makeMetrics();
    metrics.record(measurement({ outcome: 'ok', elapsedMs: 100 }));
    metrics.record(measurement({ outcome: 'error', elapsedMs: 300 }));
    metrics.record(measurement({ outcome: 'aborted', elapsedMs: 5 }));

    const snapshot = metrics.snapshot();

    expect(snapshot.totals).toMatchObject({ requests: 3, ok: 1, errors: 1, aborted: 1 });
    // 5ms 那条是「用户很快关掉了页面」，不是服务能力 —— 混进来会把尾部拉得特别好看。
    expect(snapshot.latencyMs).toMatchObject({ samples: 2, p50: 100, p95: 300, max: 300 });
  });

  it('百分位取真实观测值（最近秩），不做插值', () => {
    const metrics = makeMetrics();
    for (let i = 1; i <= 100; i += 1) {
      metrics.record(measurement({ elapsedMs: i }));
    }

    expect(metrics.snapshot().latencyMs).toEqual({
      samples: 100,
      p50: 50,
      p95: 95,
      max: 100,
      avg: 51,
    });
  });

  it('首字延迟只统计真有首字的请求（取消的也算，它确实出了字）', () => {
    const metrics = makeMetrics();
    metrics.record(measurement({ ttftMs: 120 }));
    metrics.record(measurement({ ttftMs: 300 }));
    metrics.record(measurement({ ttftMs: null }));
    // 取消发生在用户看到字之后：这段延迟是真实发生过的，和「总耗时」不一样 ——
    // 后者被取消截断，是个下界，所以不进延迟分布。
    metrics.record(measurement({ outcome: 'aborted', ttftMs: 50 }));

    expect(metrics.snapshot().ttftMs).toEqual({
      samples: 3,
      p50: 120,
      p95: 300,
      max: 300,
      avg: 157,
    });
  });

  it('只保留最近 200 条的分布，总量仍然全算', () => {
    const metrics = makeMetrics();
    for (let i = 1; i <= 250; i += 1) {
      metrics.record(measurement({ elapsedMs: i }));
    }

    const snapshot = metrics.snapshot();

    expect(snapshot.windowSize).toBe(200);
    expect(snapshot.totals.requests).toBe(250);
    // 窗口里是 51..250：最近秩 p50 = 第 100 个 = 150。
    expect(snapshot.latencyMs).toMatchObject({ samples: 200, p50: 150, max: 250, avg: 151 });
  });

  it('用量只加报了的那些，并且把「没报」数出来', () => {
    const metrics = makeMetrics();
    metrics.record(measurement({ usage: { promptTokens: 100, completionTokens: 20 } }));
    metrics.record(measurement({ usage: { promptTokens: 50, completionTokens: 5 } }));
    metrics.record(measurement({ usage: null }));

    const snapshot = metrics.snapshot();

    expect(snapshot.totals).toMatchObject({
      promptTokens: 150,
      completionTokens: 25,
      requestsWithUsage: 2,
      requestsWithoutUsage: 1,
    });
  });

  it('没配单价就不算成本 —— null 比 0 诚实', () => {
    const metrics = makeMetrics();
    metrics.record(measurement());

    expect(metrics.snapshot().cost).toBeNull();
  });

  it('配了单价时按百万 token 计价，并标出成本覆盖了几次请求', () => {
    const metrics = makeMetrics({
      LLM_PRICE_INPUT_PER_M: '2',
      LLM_PRICE_OUTPUT_PER_M: '8',
      LLM_PRICE_CURRENCY: 'CNY',
    });

    // 合计 1,000,000 prompt + 500,000 completion → 2 + 4 = 6。
    metrics.record(measurement({ usage: { promptTokens: 600_000, completionTokens: 250_000 } }));
    metrics.record(measurement({ usage: { promptTokens: 400_000, completionTokens: 250_000 } }));
    metrics.record(measurement({ usage: null }));

    expect(metrics.snapshot().cost).toEqual({
      currency: 'CNY',
      amount: 6,
      inputPerMillion: 2,
      outputPerMillion: 8,
      coveredRequests: 2,
      uncoveredRequests: 1,
    });
  });

  it('只配一半单价时启动就炸 —— 缺的那一半不会被当成 0', () => {
    expect(() => makeMetrics({ LLM_PRICE_INPUT_PER_M: '2' })).toThrow(
      'LLM_PRICE_INPUT_PER_M',
    );
  });

  it('每个请求留一行日志，带耗时、首字、用量', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    makeMetrics().record(measurement({ elapsedMs: 123.4, ttftMs: 45.6 }));

    expect(log).toHaveBeenCalledWith(expect.stringContaining('打点 ok 123ms 首字 46ms'));
  });
});
