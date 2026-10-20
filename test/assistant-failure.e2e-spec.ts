import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import type { MetricsSnapshot } from '../src/modules/assistant/assistant-metrics.service.js';
import {
  LLM_PROVIDER,
  type LlmCompletion,
  type LlmProvider,
  type LlmStream,
  type LlmStreamEvent,
} from '../src/modules/llm/llm.types.js';
import { parseSse } from './support/sse.js';

/**
 * 模型侧出故障时，用户到底看到什么。
 *
 * ── 为什么这一组值得单独一个文件 ──
 *
 * 这个项目里 23 条评测跑的都是**正常路径**：厂商回了话，我们判断它答得对不对。
 * 但真实世界里「厂商回话」本身就会失败 —— 密钥过期、余额用尽、上游 502、超时、
 * 或者回了一段根本不是 JSON 的东西。这些路径每一行都在 try/catch 里，
 * 而 try/catch 是**读代码时最容易假装自己看懂了**的东西：它看起来一定接得住。
 *
 * 所以这里把 provider 换成一个「想失败就失败」的桩，从 HTTP 这一层看结果：
 * 状态码对不对、错误话术是不是给用户看的那句、流式端点有没有把连接搞断、
 * 以及**打点有没有把这些失败算进 errors**（只统计成功的指标会反过来骗人）。
 *
 * ⚠️ 断言的是**给用户看的行为**，不是日志文本。唯一碰日志的一处是「非 JSON」
 * 那条 —— 因为那时用户只看到「格式异常」，原因只存在于日志里，而原因恰恰是
 * 排查时要看的东西（是提示词要改，还是模型偶发抖动）。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 */

/** 想让它怎么失败，就怎么失败。 */
class StubProvider implements LlmProvider {
  readonly name = 'stub-failure';

  completeMode: 'fail' | 'bad-json' = 'fail';
  streamMode: 'fail-before' | 'fail-mid' | 'bad-json' = 'fail-before';

  async complete(): Promise<LlmCompletion> {
    if (this.completeMode === 'fail') throw new Error('上游返回 500');
    return { text: '这不是 JSON，是模型的一句人话', model: 'stub', toolCalls: [] };
  }

  async stream(): Promise<LlmStream> {
    if (this.streamMode === 'fail-before') throw new Error('连接被拒绝');

    if (this.streamMode === 'bad-json') {
      return { model: 'stub', events: once({ type: 'text', text: '这不是 JSON' }) };
    }

    // 先把半句话发出去，再断 —— 这一条测的是「已经吐出去的字收不回来」时的收尾。
    return {
      model: 'stub',
      events: (async function* () {
        yield { type: 'text', text: '{"conclusion": "这句话已经发出去了' };
        throw new Error('流到一半断了');
      })(),
    };
  }
}

async function* once(event: LlmStreamEvent): AsyncGenerator<LlmStreamEvent> {
  yield event;
}

describe('模型调用失败时用户看到什么 (e2e)', () => {
  let app: NestExpressApplication;
  let stub: StubProvider;
  const warns: string[] = [];

  const ask = () =>
    request(app.getHttpServer()).post('/assistant/ask').send({
      code: 'BX-2026-0003',
      question: '这张单子为什么被驳回了？',
    });

  const askStream = () =>
    request(app.getHttpServer()).post('/assistant/askStream').send({
      code: 'BX-2026-0003',
      question: '这张单子为什么被驳回了？',
    });

  const metrics = async (): Promise<MetricsSnapshot> => {
    const response = await request(app.getHttpServer())
      .get('/assistant/metrics')
      .expect(200);
    return response.body as MetricsSnapshot;
  };

  beforeAll(async () => {
    stub = new StubProvider();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // 换掉的是**工厂的产物**，不是业务代码 —— 这也顺带证了
      // 「业务只认 LlmProvider 接口」这件事是真的。
      .overrideProvider(LLM_PROVIDER)
      .useValue(stub)
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    await app.init();

    const original = Logger.prototype.warn.bind(Logger.prototype);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (message: unknown, ...rest: unknown[]) => {
        warns.push(String(message));
        original(message, ...rest);
      },
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    warns.length = 0;
    stub.completeMode = 'fail';
    stub.streamMode = 'fail-before';
  });

  it('非流式：厂商失败 → 502，不是 500；并且记一次 error', async () => {
    const before = await metrics();

    const response = await ask().expect(502);
    // 502 的语义是「上游坏了」，500 是「我写错了」。用户看不出差别，
    // 但看日志和告警的人差别很大 —— 前者去查厂商，后者去翻代码。
    expect(response.body.message).toBe('模型调用失败，请重试');

    const after = await metrics();
    expect(after.totals.requests).toBe(before.totals.requests + 1);
    expect(after.totals.errors).toBe(before.totals.errors + 1);
    expect(after.totals.ok).toBe(before.totals.ok);
    expect(after.totals.aborted).toBe(before.totals.aborted);
    // 快照里能看出这一轮是谁在答 —— 否则这份统计没法和其他轮次两两比较。
    expect(after.provider).toBe('stub-failure');
  });

  it('模型回了非 JSON → 502，日志里写明原因和原文', async () => {
    stub.completeMode = 'bad-json';

    const response = await ask().expect(502);
    expect(response.body.message).toBe('模型回答格式异常，请重试');

    // 用户只看到「格式异常」；是提示词的问题还是模型这次抽风，只能从日志判断。
    // 所以这条日志必须同时带原因和原文，测试盯的就是这一点。
    const warning = warns.find((message) => message.includes('模型回答格式异常'));
    expect(warning).toBeDefined();
    expect(warning).toContain('这不是 JSON');
  });

  it('流式：流建立之前就失败 → 仍然是 200 + 一个 error 帧', async () => {
    // 响应头在调模型之前就发出去了（prepare 之后立刻 flush），所以这时
    // 已经不可能返回 502。协议上唯一诚实的做法是把错误放进流里 ——
    // 页面已经会渲染 error 帧，用户看到的是一句话，不是一直转圈。
    const before = await metrics();

    const response = await askStream().expect(200);
    const frames = parseSse(response.text);

    expect(frames.map((frame) => frame.event)).toEqual(['error']);
    expect(frames[0].data.message).toBe('模型调用失败，请重试');

    const after = await metrics();
    expect(after.totals.errors).toBe(before.totals.errors + 1);
    expect(after.totals.aborted).toBe(before.totals.aborted);
  });

  it('流式：吐了半句才断 → delta 之后是 error，连接正常结束', async () => {
    stub.streamMode = 'fail-mid';
    const before = await metrics();

    const response = await askStream().expect(200);
    const frames = parseSse(response.text);

    // 顺序本身是断言：先到的字已经渲染出去了，收不回来；
    // 后面必须跟一个 error（不能是 done），否则页面会把半句话当成最终结论。
    expect(frames.map((frame) => frame.event)).toEqual(['delta', 'error']);
    expect(frames[0].data.text).toBe('这句话已经发出去了');
    expect(frames[1].data.message).toBe('模型调用失败，请重试');

    // 记 error 而不是 aborted：错在厂商，不在用户。两类混在一起，
    // 「取消率」和「故障率」就再也分不开了。
    const after = await metrics();
    expect(after.totals.errors).toBe(before.totals.errors + 1);
    expect(after.totals.aborted).toBe(before.totals.aborted);
  });

  it('流式：模型说的不是 JSON → error 帧，不走 done', async () => {
    stub.streamMode = 'bad-json';

    const response = await askStream().expect(200);
    const frames = parseSse(response.text);

    expect(frames.map((frame) => frame.event)).toEqual(['error']);
    expect(frames[0].data.message).toBe('模型回答格式异常，请重试');
  });
});
