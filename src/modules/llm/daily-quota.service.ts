import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 每日调用总次数上限。
 *
 * ── 为什么限流之外还要这个 ──
 *
 * `ThrottlerModule` 管的是**每个 IP 每分钟**多少次（见 app.module.ts）。它挡得住
 * 「一个脚本猛刷」，挡不住「一万个 IP 各刷三次」—— 而后者对一个公开地址来说
 * 既便宜又常见。前者防的是压垮服务，后者防的是**烧光额度**，两种损失不一样。
 *
 * 所以这一层是「今天一共允许多少次模型调用」的**总量**闸，和按 IP 的那层互补。
 *
 * ── 为什么不在守卫里 ──
 *
 * 写在 `AssistantService` 真正调模型的那一行旁边，而不是做成 `APP_GUARD`。
 * 做成守卫的话，「什么算一次调用」会取决于路由匹配和装饰器顺序，而这些是会变的；
 * 写在调用点则只有一条规则：**真的去调模型了，就记一次**。于是 `/health` 天然不算，
 * 单号不存在（`prepare()` 先抛 404）也天然不算 —— 这两种都是「本来就不该计数」的请求。
 *
 * ── 诚实边界 ──
 *
 * 计数器在**进程内存**里。Render 免费版只有一个实例，所以它在那儿是准的；
 * 哪天扩到两个实例，实际额度就是配置值的两倍（每个实例各算各的），
 * 而且实例重启会清零。要真的准确得放进 Redis 之类的共享存储 ——
 * 这个项目的规模不值得，但**别把它说成「精确的额度控制」**。
 */
@Injectable()
export class DailyQuotaService {
  private readonly logger = new Logger(DailyQuotaService.name);

  /** 当前计的是哪一天（UTC，YYYY-MM-DD）。 */
  private day = '';
  private used = 0;

  constructor(private readonly config: ConfigService) {}

  /** 0 或未设 = 关闭。默认关闭，因为本地开发和 e2e 会被它绊住。 */
  get limit(): number {
    const raw = Number(this.config.get('LLM_DAILY_LIMIT') ?? 0);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  /**
   * 记一次调用。超限返回 false，由调用方决定怎么拒绝。
   *
   * 返回布尔而不是直接抛异常：两个端点的拒绝方式不一样（非流式抛 429，
   * 流式只能往流里发一个 error 事件 —— 那时响应头早就发出去了）。
   * 把「判什么」和「怎么拒绝」分开，这条规则就只有一份。
   */
  consume(): boolean {
    const limit = this.limit;
    if (limit === 0) return true;

    // UTC 日界。对国内用户来说这是早上 8 点重置 —— 不是最自然的切法，
    // 但「按哪个时区算一天」必须是一个确定的答案，UTC 是唯一不依赖部署位置的选择。
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }

    if (this.used >= limit) return false;

    this.used += 1;
    if (this.used === limit) {
      // 只在**刚好用满**那一刻留一条日志。每次都记的话，刷子会顺手把日志刷爆。
      this.logger.warn(`今日额度已用满（${limit} 次），后续模型调用将被拒绝`);
    }
    return true;
  }
}
