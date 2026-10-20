import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * 按 IP 统一计数的限流守卫。
 *
 * ── 为什么不直接用 `ThrottlerGuard` ──
 *
 * 库默认的 key 是 `类名-方法名-限流器名-IP`。也就是说，额度是**按端点**算的：
 * `/assistant/ask` 30 次、`/assistant/askStream` 又是 30 次，一个脚本轮着打，
 * 实际就是 60 次/分。而限流在这里防的是「一个人刷」这件事，不是「一个端点被刷」——
 * 把方法名从 key 里去掉，额度才是文档里写的那个数。
 *
 * ── 不花钱的端点为什么要豁免 ──
 *
 * `/health` 和 `/assistant/metrics` 都不碰模型，也不产生成本。它们被限流挡住时，
 * 受害的是调用它们的**机器**（平台的健康检查、看指标的人），而不是刷子。
 * 探活被 429 的老问题更严重：平台会读成「不健康」→ 重启 → 继续 429 → 死循环。
 * 所以那两个路由各自标了 `@SkipThrottle()`，这个类不替它们做决定。
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected generateKey(
    _context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    return `ip-throttle-${name}-${suffix}`;
  }
}
