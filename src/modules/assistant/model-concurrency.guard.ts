import {
  HttpException,
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Response } from 'express';
import { AssistantMetricsService } from './assistant-metrics.service.js';

/**
 * 并发上限：同一时刻最多允许多少个模型请求活着。
 *
 * ── 它和限流、日额度不是一回事 ──
 *
 *   · 限流（`RATE_LIMIT_PER_MINUTE`）管**频率**：一分钟最多进来 30 次。
 *   · 日额度（`LLM_DAILY_LIMIT`）管**总量**：一天最多花 200 次模型调用。
 *   · 这一个管**堆积**：30 次/分 × 单次最长 90 秒，最坏情况下同时有几十个请求
 *     在等模型 —— 频率完全合规，额度也还没用完，但进程内存和上游连接会先撑不住。
 *
 * 换句话说，前两个限制的是「进来了多少」，这个限制的是「同时有多少在跑」。
 * 单实例部署时它是准的；多实例各算各的，和日额度一样要乘 N。
 *
 * ── 为什么放在守卫里，而不是 service 里 ──
 *
 * 因为要在**写任何响应头之前**拒绝。放在 `streamAnswer()` 里的话，controller
 * 早就 `flushHeaders()` 了，那时唯一的表达方式是流里的一条 error 事件 ——
 * 对调用方来说，「开流之前就被拒」和「流中间出错」是完全不同的语义，
 * 前者该是一个正常的 429 JSON。
 *
 * 守卫在 handler 之前跑，所以两个端点都能拿到干净的状态码。
 */

const DEFAULT_MAX_CONCURRENT_ASKS = 8;

/**
 * 读 `MAX_CONCURRENT_ASKS`。0 = 关掉上限。
 *
 * 非法值回落默认值而不是启动失败：这个值只影响「拒绝得多不多」，
 * 不像密钥或数据库地址那样配错就完全是另一回事。回落到默认值最坏是
 * 拒绝得比预期多/少，不会让服务起不来。
 */
export function maxConcurrentAsks(): number {
  const raw = process.env.MAX_CONCURRENT_ASKS?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_ASKS;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_CONCURRENT_ASKS;
  return Math.floor(value);
}

@Injectable()
export class ModelConcurrencyGuard implements CanActivate {
  private active = 0;

  constructor(private readonly metrics: AssistantMetricsService) {}

  canActivate(context: ExecutionContext): boolean {
    const limit = maxConcurrentAsks();
    if (limit === 0) return true;

    if (this.active >= limit) {
      // 被挡下的请求不会进 `record()` —— 不单独数一笔，指标里就没有「正在被压」的迹象。
      this.metrics.recordRejection('concurrency');
      throw new HttpException(
        '当前请求太多，请稍后再试',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.active += 1;

    const res = context.switchToHttp().getResponse<Response>();
    let released = false;
    const release = (): void => {
      // 正常结束走 `finish`、客户端断开走 `close`，两个都会挂 ——
      // 不判一次的话，同一次请求会把额度还两遍，上限就形同虚设。
      if (released) return;
      released = true;
      this.active -= 1;
    };
    res.on('finish', release);
    res.on('close', release);

    return true;
  }
}
