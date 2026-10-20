import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmUsage,
} from '../llm/llm.types.js';

/**
 * 请求打点。
 *
 * ── 它回答的问题 ──
 *
 * 「这个服务贵不贵、快不快」—— 两个 README 里最该有、也最容易被一句「还行」糊弄过去的问题。
 * 日志能回答单次请求，但回答不了分布：一次 3 秒的请求是常态还是尾部？
 * 成本是按调用次数算的，还是被长答案撑起来的？这些只能聚合出来看。
 *
 * ── 为什么记在进程内存里 ──
 *
 * 和 `DailyQuotaService` 是同一个取舍，也同一个诚实边界：Render 免费版只有一个实例，
 * 所以这里的数字在那个环境里是准的；多实例时每个实例各算各的，`GET /assistant/metrics`
 * 打到谁就只看得到谁。重启清零。要真的准确就得进共享存储（Redis / 时序库），
 * 这个项目的规模不值得 —— 但**别把这些数字说成全局统计**。
 *
 * ── 为什么只有最近 200 条 ──
 *
 * 百分位要的是分布，不是历史。内存要有上界，否则一个公开服务跑一周就能把进程撑大。
 * 总计数另外用 O(1) 的累加器记，不受窗口影响。
 *
 * ── 关于成本 ──
 *
 * 成本**不算**在这里猜：单价随厂商、模型、缓存命中率变化，写死在代码里等于制造一个
 * 看起来精确的错数字。所以单价从环境变量读，没配就返回 `null`（「不知道」），
 * 而不是 0。即便配了，它也**没算缓存价**（DeepSeek 等厂商对命中缓存的 prompt
 * 收得更低），用之前先去厂商价目表核对 —— 这里只负责把公式和口径摆出来。
 */

/** 一次请求的结局。取消（用户关页面）既不算成功也不算失败，单独一类。 */
export type RequestOutcome = 'ok' | 'error' | 'aborted';

export interface RequestMeasurement {
  outcome: RequestOutcome;
  /** 端到端耗时。从 prepare() 开始算 —— 包含那一次「单号存在吗」的查询。 */
  elapsedMs: number;
  /** 第一个字到达客户端的耗时。只有流式端点有，非流式为 null。 */
  ttftMs: number | null;
  /** 这次请求调用了几次模型（工具循环的轮数）。 */
  modelCalls: number;
  /** 这次请求执行了几次工具调用。 */
  toolCalls: number;
  /** 工具执行耗时之和（串行累加，不含模型时间）。 */
  toolMs: number;
  /** 厂商报的用量之和。任一轮没报，这里就是 null（见 addUsage）。 */
  usage: LlmUsage | null;
}

export interface LatencySummary {
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  avg: number | null;
}

export interface MetricsSnapshot {
  provider: string;
  startedAt: string;
  uptimeMs: number;
  windowSize: number;
  totals: {
    requests: number;
    ok: number;
    errors: number;
    aborted: number;
    modelCalls: number;
    toolCalls: number;
    promptTokens: number;
    completionTokens: number;
    /** 报了用量的请求数 / 没报的请求数。token 总量只覆盖前者。 */
    requestsWithUsage: number;
    requestsWithoutUsage: number;
  };
  /** 只统计**已完成**的请求（ok + error）。取消的请求时长是下界，混进来会让尾部偏乐观。 */
  latencyMs: LatencySummary;
  /** 只统计确实测到了首字的流式请求。 */
  ttftMs: LatencySummary;
  cost: {
    currency: string;
    /** 单价 × 已覆盖的 token。没配单价时为 null。 */
    amount: number;
    inputPerMillion: number;
    outputPerMillion: number;
    /** 成本覆盖范围：没报用量的请求**不在**里面。 */
    coveredRequests: number;
    uncoveredRequests: number;
  } | null;
}

/** 百分位窗口的大小。200 条对 p95 来说每侧还有 10 个样本，够用且内存有界。 */
const WINDOW_SIZE = 200;

@Injectable()
export class AssistantMetricsService {
  private readonly logger = new Logger(AssistantMetricsService.name);
  private readonly startedAt = Date.now();
  private readonly window: RequestMeasurement[] = [];
  private readonly prices: { input: number; output: number; currency: string } | null;

  private readonly totals = {
    requests: 0,
    ok: 0,
    errors: 0,
    aborted: 0,
    modelCalls: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    requestsWithUsage: 0,
    requestsWithoutUsage: 0,
  };

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    config: ConfigService,
  ) {
    this.prices = readPrices(config);
  }

  record(measurement: RequestMeasurement): void {
    const t = this.totals;

    t.requests += 1;
    if (measurement.outcome === 'ok') t.ok += 1;
    else if (measurement.outcome === 'error') t.errors += 1;
    else t.aborted += 1;

    t.modelCalls += measurement.modelCalls;
    t.toolCalls += measurement.toolCalls;

    if (measurement.usage) {
      t.requestsWithUsage += 1;
      t.promptTokens += measurement.usage.promptTokens;
      t.completionTokens += measurement.usage.completionTokens;
    } else {
      // 不是「花了 0 个 token」，是「厂商没说」。这两个在成本上是两回事。
      t.requestsWithoutUsage += 1;
    }

    this.window.push(measurement);
    if (this.window.length > WINDOW_SIZE) this.window.shift();

    // 每个请求一行，方便在平台日志里直接 grep。ttft 只有流式有，打印时区分开。
    this.logger.log(
      `打点 ${measurement.outcome} ${Math.round(measurement.elapsedMs)}ms` +
        (measurement.ttftMs === null ? '' : ` 首字 ${Math.round(measurement.ttftMs)}ms`) +
        ` 模型 ${measurement.modelCalls} 轮 工具 ${measurement.toolCalls} 次` +
        (measurement.usage
          ? ` tokens ${measurement.usage.promptTokens}/${measurement.usage.completionTokens}`
          : ' tokens 未报'),
    );
  }

  snapshot(): MetricsSnapshot {
    const t = this.totals;
    // 取消的请求不进延迟分布：它们的耗时是「用户忍了多久」，不是「服务要多久」。
    const completed = this.window.filter((m) => m.outcome !== 'aborted');
    const ttfts = this.window
      .map((m) => m.ttftMs)
      .filter((ms): ms is number => ms !== null);

    const cost =
      this.prices === null
        ? null
        : {
            currency: this.prices.currency,
            amount: round6(
              (t.promptTokens / 1_000_000) * this.prices.input +
                (t.completionTokens / 1_000_000) * this.prices.output,
            ),
            inputPerMillion: this.prices.input,
            outputPerMillion: this.prices.output,
            coveredRequests: t.requestsWithUsage,
            uncoveredRequests: t.requestsWithoutUsage,
          };

    return {
      provider: this.llm.name,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      windowSize: WINDOW_SIZE,
      totals: { ...t },
      latencyMs: summarize(completed.map((m) => m.elapsedMs)),
      ttftMs: summarize(ttfts),
      cost,
    };
  }
}

function summarize(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { samples: 0, p50: null, p95: null, max: null, avg: null };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
    avg: Math.round(sum / sorted.length),
  };
}

/** 最近秩法（nearest-rank）。样本少的时候比插值法诚实：它返回的一定是**真实观测值**。 */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * 读单价。两个都没配 = 不算成本（返回 null）；**只配一个**当作配置错误。
 *
 * 只配一个的时候，按 0 处理另一个会得到一个偏低且看不出问题的成本 ——
 * 这正是这个项目一直在防的那类失败：错得不够响。启动时炸掉，比上线后算错好。
 */
function readPrices(
  config: ConfigService,
): { input: number; output: number; currency: string } | null {
  const rawInput = config.get<string>('LLM_PRICE_INPUT_PER_M');
  const rawOutput = config.get<string>('LLM_PRICE_OUTPUT_PER_M');
  const hasInput = rawInput !== undefined && rawInput !== '';
  const hasOutput = rawOutput !== undefined && rawOutput !== '';
  if (!hasInput && !hasOutput) return null;

  if (!hasInput || !hasOutput) {
    throw new Error(
      '成本单价必须同时配置 LLM_PRICE_INPUT_PER_M 和 LLM_PRICE_OUTPUT_PER_M，' +
        '只配一个就没法算出可信的成本（缺的那一半不会被当成 0）。',
    );
  }

  return {
    input: readPrice('LLM_PRICE_INPUT_PER_M', rawInput),
    output: readPrice('LLM_PRICE_OUTPUT_PER_M', rawOutput),
    currency: config.get<string>('LLM_PRICE_CURRENCY') || 'CNY',
  };
}

function readPrice(key: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} 必须是一个非负数（单位：每百万 token 的价格），当前值：${raw}`);
  }
  return value;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
