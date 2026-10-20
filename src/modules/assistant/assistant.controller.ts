import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AssistantMetricsService } from './assistant-metrics.service.js';
import type { MetricsSnapshot } from './assistant-metrics.service.js';
import { AssistantService } from './assistant.service.js';
import { AskDto } from './ask.dto.js';
import type { AskResult, AssistantStreamEvent } from './ask.types.js';

@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly metrics: AssistantMetricsService,
  ) {}

  /**
   * 打点快照。
   *
   * ⚠️ 这是**进程内存**里的统计，不是全局统计：多实例部署时打到谁只看得到谁，
   * 重启清零。它也不记问题内容和单号 —— 统计不该顺手变成一份访问日志。
   *
   * 成本只在配了单价时出现（见 `assistant-metrics.service.ts` 顶部那段）。
   *
   * `@SkipThrottle()`：它不碰模型、不花钱，也不是用户会连着点的东西。
   * 更重要的是限流现在按 IP **跨端点共用**一份额度（见 ip-throttler.guard.ts）——
   * 看指标的人要是把额度吃掉了，真正提问的人就被挡在外面了。
   */
  @SkipThrottle()
  @Get('metrics')
  metricsSnapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  /**
   * POST 而不是 GET：问题在 body 里。中文进 URL 会被各级日志和代理原样记下来，
   * 而「用户问了什么」不该躺在访问日志里。
   *
   * 显式标 200：Nest 对 POST 默认返回 201，但这个接口没有创建任何资源，
   * 201 会让调用方以为多了个东西。
   */
  @Post('ask')
  @HttpCode(HttpStatus.OK)
  ask(@Body() dto: AskDto): Promise<AskResult> {
    return this.assistant.ask(dto);
  }

  /**
   * 流式版，SSE。
   *
   * 用 POST 而不是 GET，理由同上；也正因为是 POST，**不能用 Nest 的 `@Sse()`** ——
   * 那个装饰器隐含 GET，套不上这里。所以只能自己注入 `@Res()` 手写响应头和分帧。
   *
   * 注入 `@Res()` 还有个附带效果：Nest 不再管这个响应，返回值会被忽略。
   * 所以这个 handler 返回 `void`，不要返回别的 —— 返回了也不会被发出去，
   * 只会让读代码的人以为它在起作用。
   */
  @Post('askStream')
  async askStream(
    @Body() dto: AskDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // ⚠️ 取数必须在写响应头**之前**完成：它可能抛 404，
    // 而头一旦发出去，就再也没法返回一个正常的 JSON 错误了 ——
    // 只能把错误塞进流里，但那对调用方是完全不同的语义。
    const prepared = await this.assistant.prepare(dto);

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 部署在 nginx 后面时，不开这个头，nginx 会把整段流缓冲成一坨再一次性发出去 ——
    // 症状是「本地好好的，一上线就没有流式效果了」。
    // 本地没有 nginx，所以这个坑只会在部署那天出现。
    res.setHeader('X-Accel-Buffering', 'no');
    // 上面几行只是排队，这一句才真的把头发出去。不 flush 的话，
    // 响应头会一直等到第一次 `res.write` 才走 —— 那时错误已经来不及改了。
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      // ⚠️ 这里必须判 `writableEnded`。
      // 响应正常写完时 `close` 也会触发，光看 `close` 分不清「用户走了」
      // 和「我们写完了」—— 前者要掐掉模型请求，后者什么都不用做。
      if (!res.writableEnded) {
        abort.abort();
      }
    });

    try {
      for await (const event of this.assistant.streamAnswer(
        prepared,
        abort.signal,
      )) {
        writeEvent(res, event);
      }
    } finally {
      // 用 finally：中途抛异常（比如序列化失败）时也要把连接关掉，
      // 否则这个响应永远不结束，客户端的 `reader.read()` 会一直挂着。
      res.end();
    }
  }
}

/**
 * 把事件写成 SSE 帧。
 *
 * 分帧的语法（`event:` / `data:` / 空行结尾）只出现在这里 ——
 * service 只吐事件对象，不知道 HTTP 长什么样。想在 WebSocket 上复用那条流时，
 * 换掉的是这个函数，不是 service。
 */
function writeEvent(res: Response, event: AssistantStreamEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(eventPayload(event))}\n\n`);
}

/** `type` 已经写在 `event:` 行里了，data 里就不再重复一遍。 */
function eventPayload(event: AssistantStreamEvent): unknown {
  switch (event.type) {
    case 'delta':
      return { text: event.text };
    case 'done':
      return event.data;
    case 'error':
      return { message: event.message };
  }
}
