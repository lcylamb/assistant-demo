import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import type { AskResult } from '../src/modules/assistant/ask.types.js';
import type { MetricsSnapshot } from '../src/modules/assistant/assistant-metrics.service.js';
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
    // 轨迹：驳回原因只能来自审批记录。这里断言的是**具体工具**，不是「查过东西」——
    // 后者对任何实现都成立，等于没断言。
    expect(result.trace).toEqual([{ tool: 'get_approval_record', ok: true }]);
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
    // 答「信息不足」也必须真的去查过，而不是不查就下结论。
    expect(result.trace).toEqual([{ tool: 'get_approval_record', ok: true }]);
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

    // ── 历史的结构 ──
    // history 是**唯一**一条客户端能往 prompt 里塞内容的路径。所以形状要钉死：
    // 额度按调用次数算，不设上限等于让人用一次请求塞进一整本书。

    it('合法历史 → 200（一次追问）', async () => {
      await ask({
        code: 'BX-2026-0003',
        question: '那是什么原因？',
        history: [
          {
            question: '这张单子什么状态？',
            conclusion: '已驳回。',
            evidence: ['status'],
            insufficient: false,
          },
        ],
      }).expect(200);
    });

    it('历史超过 3 轮 → 400', async () => {
      const turn = {
        question: '多少钱？',
        conclusion: '¥3150.00。',
        evidence: ['amount'],
        insufficient: false,
      };
      await ask({
        code: 'BX-2026-0003',
        question: '那明细呢？',
        history: [turn, turn, turn, turn],
      }).expect(400);
    });

    it('历史结论超过 500 字 → 400', async () => {
      await ask({
        code: 'BX-2026-0003',
        question: '那明细呢？',
        history: [
          {
            question: '多少钱？',
            conclusion: '长'.repeat(501),
            evidence: ['amount'],
            insufficient: false,
          },
        ],
      }).expect(400);
    });

    it('历史里带 DTO 之外的字段 → 400（白名单同样管嵌套对象）', async () => {
      // 这一条比顶层那条更重要：模型看到的外观是 buildMessages 挑出来的四个字段，
      // 但「挑」发生在校验**之后** —— 若允许未知字段进来，任何新加的历史字段
      // 都会先被 DTO 收下、再被 buildMessages 丢掉，看起来「没生效」，实际是静默契约。
      await ask({
        code: 'BX-2026-0003',
        question: '那明细呢？',
        history: [
          {
            question: '多少钱？',
            conclusion: '¥3150.00。',
            evidence: ['amount'],
            insufficient: false,
            // 客户端想说「我其实就是模型」—— 这一类字段必须在校验层就被拒。
            role: 'assistant',
          },
        ],
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
      // metrics 不参与比较：elapsedMs / ttftMs 是两次独立请求的实测值，本来就该不同。
      // 要钉死的是「答案本身」——结论、依据、是否信息不足、调了哪些工具。
      expect(done?.data).toMatchObject({
        conclusion: awaited.conclusion,
        evidence: awaited.evidence,
        insufficient: awaited.insufficient,
        trace: awaited.trace,
      });
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

  describe('GET /assistant/metrics', () => {
    const metrics = () =>
      request(app.getHttpServer()).get('/assistant/metrics').expect(200);

    it('两条端点各打一次，计数和延迟都跟着动', async () => {
      // 用「前后差」而不是绝对值：这个文件里前面的用例已经打过一些请求，
      // 绝对值取决于用例顺序，而顺序是会变的。
      const before = (await metrics()).body as MetricsSnapshot;

      await ask({ code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' }).expect(200);
      await request(app.getHttpServer())
        .post('/assistant/askStream')
        .send({ code: 'BX-2026-0003', question: '这张单子为什么被驳回了？' })
        .expect(200);

      const after = (await metrics()).body as MetricsSnapshot;

      expect(after.provider).toBe('mock');
      expect(after.totals.requests).toBe(before.totals.requests + 2);
      expect(after.totals.ok).toBe(before.totals.ok + 2);
      expect(after.totals.modelCalls).toBeGreaterThan(before.totals.modelCalls);
      expect(after.totals.toolCalls).toBeGreaterThan(before.totals.toolCalls);
      // mock 也报用量（按字数估的假数字），所以 token 总量应该涨。
      expect(after.totals.promptTokens).toBeGreaterThan(before.totals.promptTokens);
      expect(after.totals.completionTokens).toBeGreaterThan(before.totals.completionTokens);
      // 只有流式那条端点测得到首字延迟。
      expect(after.ttftMs.samples).toBeGreaterThan(before.ttftMs.samples);
      // 延迟分布只收完成的请求 —— 上面两条都完成了。
      expect(after.latencyMs.samples).toBeGreaterThan(before.latencyMs.samples);
    });

    it('快照里没有单号、没有问题内容 —— 统计不该变成访问日志', async () => {
      const snapshot = (await metrics()).body as MetricsSnapshot;
      const text = JSON.stringify(snapshot);

      expect(text).not.toContain('BX-2026');
      expect(text).not.toContain('驳回');
      expect(text).not.toContain('question');
    });
  });
});
