import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import {
  LLM_PROVIDER,
  type LlmCompletion,
  type LlmProvider,
  type LlmStream,
} from '../src/modules/llm/llm.types.js';
import { countHeartbeats, parseSse } from './support/sse.js';

/**
 * 空闲时的心跳。
 *
 * ── 这条用例在防什么 ──
 *
 * 工具轮里有一段时间**一个字节都不发**：第一轮模型只回一个工具调用，接着查库，
 * 再调第二轮模型才出第一个字。中间那条连接对代理来说是空闲的，而 nginx 的
 * `proxy_read_timeout` 默认 60 秒、Cloudflare 是 100 秒 —— 超了直接断。
 *
 * 症状极难查：本地（没有代理）一点问题都没有，线上表现为「说到一半没了」，
 * 后端日志里一切正常，因为它确实把字都发出去了，只是没人收到。
 *
 * 解法是 SSE 的注释帧（`: ping`），规范要求客户端忽略。所以这里同时钉住三件事：
 *   1. 空闲时确实发了注释帧；
 *   2. 它出现在第一个 `delta` **之前**（否则说明它没在覆盖那段空档）；
 *   3. 它不会变成一帧业务事件（解析器必须跳过没有 `data:` 的帧）。
 *
 * 用 250ms 的假模型延迟 + 40ms 的心跳间隔来把「几秒钟」压缩到测试能接受的长度。
 */

class SlowProvider implements LlmProvider {
  readonly name = 'stub-slow';

  async complete(): Promise<LlmCompletion> {
    throw new Error('这个用例只走流式');
  }

  async stream(): Promise<LlmStream> {
    return {
      model: 'stub',
      events: (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 250));
        yield {
          type: 'text' as const,
          text: '{"conclusion":"慢模型答完了","evidence":[],"insufficient":false}',
        };
      })(),
    };
  }
}

const body = { code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' };

describe('流式心跳 (e2e)', () => {
  let app: NestExpressApplication;
  let original: string | undefined;

  beforeAll(async () => {
    original = process.env.SSE_HEARTBEAT_MS;
    process.env.SSE_HEARTBEAT_MS = '40';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(new SlowProvider())
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    await app.init();
  });

  afterAll(async () => {
    if (original === undefined) delete process.env.SSE_HEARTBEAT_MS;
    else process.env.SSE_HEARTBEAT_MS = original;
    await app.close();
  });

  it('空档里发注释帧，并且出现在第一个 delta 之前', async () => {
    const response = await request(app.getHttpServer())
      .post('/assistant/askStream')
      .send(body)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(countHeartbeats(response.text)).toBeGreaterThanOrEqual(2);

    // 顺序是断言的一部分：心跳要是只在收尾时才发，它就没覆盖住真正危险的那段空档。
    expect(response.text.indexOf(': ping')).toBeLessThan(
      response.text.indexOf('event: delta'),
    );

    // 注释帧不能污染业务事件。解析器跳过它之后，帧序列应该干干净净。
    const frames = parseSse(response.text);
    expect(frames.map((frame) => frame.event)).toEqual(['delta', 'done']);
    expect(frames[1].data.conclusion).toBe('慢模型答完了');
  });

  it('设成 0 就关掉（本地想看干净原始流时用）', async () => {
    process.env.SSE_HEARTBEAT_MS = '0';

    try {
      const response = await request(app.getHttpServer())
        .post('/assistant/askStream')
        .send(body)
        .expect(200);

      expect(countHeartbeats(response.text)).toBe(0);
      expect(parseSse(response.text).map((frame) => frame.event)).toEqual([
        'delta',
        'done',
      ]);
    } finally {
      process.env.SSE_HEARTBEAT_MS = '40';
    }
  });
});
