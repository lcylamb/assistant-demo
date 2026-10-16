import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import type { AskResult } from '../src/modules/assistant/ask.types.js';
import { asResult, parseSse } from './support/sse.js';

/**
 * `/assistant/ask` 的端到端测试。
 *
 * 需要数据库在跑且已经 seed 过（`npm run db:up && npm run db:seed`）。
 * 用的是 seed 里那两条**刻意设计**的记录：
 *   · BX-2026-0003  已驳回、有驳回原因  → 能答
 *   · BX-2026-0005  草稿、没有审批意见  → 必须答「信息不足」
 *
 * 注意这里断言的是**语义**（该不该 insufficient、依据里有没有那个字段），
 * 不是模型的措辞 —— 措辞会随模型换而变，语义不该变。评测集用的是同一套思路。
 */
describe('AssistantController (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyGlobalSetup(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const ask = (body: object) =>
    request(app.getHttpServer()).post('/assistant/ask').send(body);

  it('问已驳回的单子，答得出原因、依据里有 rejectReason', async () => {
    const response = await ask({
      code: 'BX-2026-0003',
      question: '这张单子为什么被驳回了？',
    }).expect(200);

    const result = response.body as AskResult;
    expect(result.insufficient).toBe(false);
    expect(result.conclusion).toContain('招待费超出');
    expect(result.evidence).toContain('rejectReason');
    expect(result.evidence).toContain('status');
  });

  it('问草稿单的审批意见，必须答「信息不足」而不是编一个', async () => {
    const response = await ask({
      code: 'BX-2026-0005',
      question: '审批意见是什么？',
    }).expect(200);

    const result = response.body as AskResult;
    expect(result.insufficient).toBe(true);
    // 数据里没有 rejectReason / decidedAt，所以它不该出现在依据里
    expect(result.evidence).not.toContain('rejectReason');
    expect(result.evidence).not.toContain('decidedAt');
  });

  it('单号不存在 → 404，不是 500', async () => {
    await ask({ code: 'BX-2026-9999', question: '多少钱？' }).expect(404);
  });

  describe('入参校验', () => {
    it('单号格式不对 → 400', async () => {
      await ask({ code: 'not-a-code', question: '多少钱？' }).expect(400);
    });

    it('缺少 question → 400', async () => {
      await ask({ code: 'BX-2026-0003' }).expect(400);
    });

    it('多传了 DTO 里没有的字段 → 400（而不是被悄悄忽略）', async () => {
      await ask({
        code: 'BX-2026-0003',
        question: '多少钱？',
        role: 'admin',
      }).expect(400);
    });
  });

  describe('POST /assistant/askStream', () => {
    const askStream = (body: object) =>
      request(app.getHttpServer()).post('/assistant/askStream').send(body);

    it('两条端点给出**完全相同**的结论', async () => {
      // 这条是整个流式改造里最该有的一条断言：两条路必须共用同一份 prompt
      // 和同一套收口校验。它一旦漂移，症状是「流式答得和非流式不一样」，
      // 两边单看都「能跑」，极难查。
      const body = { code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' };

      const awaited = (await ask(body).expect(200)).body as AskResult;
      const streamed = parseSse((await askStream(body).expect(200)).text);
      const done = streamed.find((frame) => frame.event === 'done');

      expect(done).toBeDefined();
      expect(done?.data).toEqual(awaited);
    });

    it('增量吐出来的字，逐字等于最终结论', async () => {
      const response = await askStream({
        code: 'BX-2026-0006',
        question: '这笔钱都花在哪些项目上？',
      }).expect(200);

      expect(response.headers['content-type']).toContain('text/event-stream');

      const frames = parseSse(response.text);
      const deltas = frames
        .filter((frame) => frame.event === 'delta')
        .map((frame) => frame.data.text as string);
      const done = frames.find((frame) => frame.event === 'done');

      expect(deltas.length).toBeGreaterThan(1); // 确实是一块一块来的，不是一次性
      expect(deltas.join('').trimEnd()).toBe(asResult(done).conclusion);
    });

    it('事件顺序是 delta… → done，中途不夹 error', async () => {
      const response = await askStream({
        code: 'BX-2026-0005',
        question: '审批意见是什么？',
      }).expect(200);

      const events = parseSse(response.text).map((frame) => frame.event);
      expect(events.at(-1)).toBe('done');
      expect(events).not.toContain('error');
      expect(events.filter((name) => name === 'done')).toHaveLength(1);
    });

    it('草稿单同样判为信息不足', async () => {
      const response = await askStream({
        code: 'BX-2026-0005',
        question: '审批意见是什么？',
      }).expect(200);

      const done = parseSse(response.text).find((f) => f.event === 'done');
      expect(asResult(done).insufficient).toBe(true);
    });

    it('单号不存在 → 404 的 **JSON**，不是一段流', async () => {
      // 这条钉住的是时序：取数必须在写响应头之前完成。
      // 头一旦发出去，就只能把错误塞进流里 —— 那时调用方拿到的会是一个
      // 200 + SSE，而不是 404。语义完全不同。
      const response = await askStream({
        code: 'BX-2026-9999',
        question: '多少钱？',
      }).expect(404);

      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toMatchObject({ statusCode: 404 });
    });

    it('入参不合法 → 400 的 JSON', async () => {
      await askStream({ code: 'nope', question: '多少钱？' }).expect(400);
    });
  });
});
