import { Logger } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import type { MockInstance } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_OPTIONS, applyGlobalSetup } from '../src/app-setup.js';
import {
  LLM_PROVIDER,
  type LlmCompletion,
  type LlmMessage,
  type LlmProvider,
  type LlmRequestOptions,
  type LlmStream,
  type LlmStreamEvent,
} from '../src/modules/llm/llm.types.js';

/**
 * 优雅退出的边界：活跃的 SSE 流不能把关闭拖住。
 *
 * ── 这条用例在防什么 ──
 *
 * `enableShutdownHooks()` 只保证「信号到了应用」，不保证「应用能很快走完」。
 * Nest 关服务时调的是 `server.close()`，它的语义是**等所有活跃请求结束**。
 * 普通接口几百毫秒，等得起；SSE 可能正跑着一次最长 4 轮的模型调用
 * （每轮超时 30 秒）。平台不会等那么久：Docker 给 10 秒就 SIGKILL（退出码 137）。
 *
 * 所以真正的失效点不是「没有钩子」，而是「有钩子，但关闭被长连接拖过了宽限期」。
 * 症状和没接信号几乎一样：进程被强杀，看起来像优雅退出从来没生效。
 *
 * 修法在 `APP_OPTIONS.forceCloseConnections`（见 src/app-setup.ts）：
 * 关闭时直接销毁 socket，不等活跃连接。这里钉住两件事：
 *   1. 流还在写的时候，`app.close()` 在毫秒级返回，而不是等流跑完；
 *   2. 销毁钩子照样跑完了（`$disconnect` 那行日志），不是「关得快 = 没收拾」。
 *
 * 客户端这边拿到的是**断开的连接**，不是一条假装完整的回答 ——
 * 页面上对应的就是失败气泡「连接提前结束了，这次回答不完整，请重试」。
 *
 * 用 `app.listen(0)` + 原生 `fetch` 而不是 supertest：这条用例需要
 * 「请求还没结束，就去关应用」，而 supertest 面向的是完整的请求-响应。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */

class SlowStreamProvider implements LlmProvider {
  readonly name = 'stub-slow-stream';

  async complete(): Promise<LlmCompletion> {
    throw new Error('这个用例只走流式');
  }

  async stream(
    _messages: LlmMessage[],
    options: LlmRequestOptions = {},
  ): Promise<LlmStream> {
    const { signal } = options;

    return {
      model: 'stub',
      events: (async function* (): AsyncGenerator<LlmStreamEvent> {
        // 先给出结论的开头，客户端因此能拿到一个真实的 delta。
        yield { type: 'text', text: '{"conclusion":"' };

        // 50 个字 × 50ms ≈ 2.5 秒。这个时长是故意的：远大于「关闭应该花的时间」，
        // 又短到万一没有强断，用例也不会挂太久。
        for (let i = 0; i < 50; i += 1) {
          await sleep(50);
          if (signal?.aborted) return;
          yield { type: 'text', text: '字' };
        }
      })(),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const body = {
  code: 'BX-2026-0003',
  question: '这张单子为什么被驳回了？',
};

/** 关闭耗时上限。强断是毫秒级的事，1 秒已经宽到能容下慢 CI。 */
const CLOSE_BUDGET_MS = 1000;
/** 没修好时 `close()` 会一直等流跑完（约 2.5 秒），用这个超时先让用例失败。 */
const CLOSE_DEADLINE_MS = 2000;
/** 连接被掐断之后，客户端读操作应该很快结束；超过这个时间说明它挂住了。 */
const CLIENT_SETTLE_MS = 1000;

describe('优雅退出 (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let closed = false;

  // 关掉日志输出并顺手留下证据：销毁钩子到底跑没跑。
  const logs: string[] = [];
  let logSpy: MockInstance;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(new SlowStreamProvider())
      .compile();

    // 和 main.ts 用**同一个**常量。测试里手写一遍选项的话，测的就只是测试自己的配置。
    app =
      moduleFixture.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    applyGlobalSetup(app);
    await app.listen(0);

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    logSpy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(' '));
      });
  });

  afterAll(async () => {
    // 用例里已经关过一次就别再关：Nest 会再跑一遍销毁钩子。
    if (!closed) await app.close();
    logSpy.mockRestore();
  });

  it('流还在写的时候，close() 不等它跑完', async () => {
    const response = await fetch(`${baseUrl}/assistant/askStream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';

    // 等到**真的出了一个增量**再关：这时服务端确实有一条活跃的 SSE 连接，
    // 而不是「请求刚发出去、还没开始写」。
    while (!received.includes('event: delta')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('流在第一个增量之前就结束了，这条用例无从谈起');
      received += decoder.decode(value, { stream: true });
    }

    const startedAt = Date.now();
    closed = true;
    const verdict = await Promise.race([
      app.close().then(() => 'closed' as const),
      sleep(CLOSE_DEADLINE_MS).then(() => 'timeout' as const),
    ]);
    const elapsed = Date.now() - startedAt;

    expect(verdict).toBe('closed');
    expect(elapsed).toBeLessThan(CLOSE_BUDGET_MS);

    // 关得快不等于没收拾：销毁钩子（`$disconnect`）必须跑完。
    expect(logs.some((line) => line.includes('数据库连接已释放'))).toBe(true);

    // 客户端这边：连接被掐断。读操作要么读到 EOF、要么报错，
    // 不能一直挂着 —— 而无论如何都不该收到一个 `done` 帧。
    let tail = '';
    const outcome = await Promise.race([
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return 'eof' as const;
            tail += decoder.decode(value, { stream: true });
          }
        } catch {
          // 强断没有「优雅 EOF」，读会直接抛 —— 预期之内。
          return 'error' as const;
        }
      })(),
      sleep(CLIENT_SETTLE_MS).then(() => 'hung' as const),
    ]);

    expect(['eof', 'error']).toContain(outcome);
    expect(received + tail).not.toContain('event: done');
  });
});
