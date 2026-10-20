import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { applyGlobalSetup } from '../src/app-setup.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  LLM_PROVIDER,
  type LlmCompletion,
  type LlmProvider,
  type LlmStream,
  type LlmToolCall,
} from '../src/modules/llm/llm.types.js';
import { parseSse } from './support/sse.js';

/**
 * 服务**起来之后**数据库挂了，用户看到什么。
 *
 * ── 为什么不并进 assistant-failure ──
 *
 * 那个文件测的是「模型那侧出错」。这里是另一条完全不同的故障链：库连不上。
 * 两者的错误码、话术、以及「还能不能继续跑」的判断都不一样，混在一个 describe 里
 * 只会让每个用例的前置条件都变得可疑。
 *
 * ── 这一组盯的是两件事 ──
 *
 * 1. **状态码**：库连不上是 503（基础设施问题，稍后重试有意义），不是 500
 *    （500 的意思是「我写错了」，会把人引去翻代码）。
 * 2. **不能降级成「信息不足」**：工具查询失败时如果只是让模型「换个方式或直接说
 *    信息不足」，用户会拿到一个 200 + 「查不到」的答案 —— 而真相是整张单子都读不了。
 *    这种「看起来成功的错误答案」比 503 危险，因为它和「数据里确实没有」
 *    在响应里完全没法区分。
 *
 * 数据库和模型都换成桩：要复现的是**连不上库**这一种状态，不是真的去拔网线。
 * 启动时的连接检查（PrismaService.onModuleInit）在桩上不会跑 —— 这正是重点：
 * 服务是「起来之后」才发现库没了的。
 */

const CODE = 'BX-2026-0003';
const UNAVAILABLE = '数据库暂时不可用，请稍后重试';

function p1001(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Invalid `prisma.expense.findUnique()` invocation\n\nCan't reach database server at db:5432",
    { code: 'P1001', clientVersion: '7.10.1' },
  );
}

/**
 * 只实现被用到的那一个方法。
 *
 * `where: prepare` —— 取单号时就挂；`where: tool` —— 取数成功，工具查询时挂。
 * 用 `select.id` 区分：prepare 只查 id，三个工具的 select 都不含 id。
 */
function outagePrisma(where: 'prepare' | 'tool'): PrismaService {
  return {
    expense: {
      findUnique: async ({ select }: { select?: Record<string, boolean> }) => {
        if (where === 'prepare' || !select?.id) throw p1001();
        return { id: 'exp_1' };
      },
    },
  } as unknown as PrismaService;
}

/** 只会要工具、不会自己作答的模型 —— 逼着请求走进工具那一步。 */
class ToolCallingProvider implements LlmProvider {
  readonly name = 'stub-tool-calling';

  private call(): LlmToolCall {
    return { id: 'call_1', name: 'get_expense_summary', arguments: '{}' };
  }

  async complete(): Promise<LlmCompletion> {
    return { text: '', model: 'stub', toolCalls: [this.call()] };
  }

  async stream(): Promise<LlmStream> {
    return {
      model: 'stub',
      events: (async function* () {
        yield {
          type: 'tool_call' as const,
          call: { id: 'call_1', name: 'get_expense_summary', arguments: '{}' },
        };
      })(),
    };
  }
}

async function boot(
  where: 'prepare' | 'tool',
): Promise<NestExpressApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_PROVIDER)
    .useValue(new ToolCallingProvider())
    .overrideProvider(PrismaService)
    .useValue(outagePrisma(where))
    .compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  applyGlobalSetup(app);
  await app.init();
  return app;
}

const body = { code: CODE, question: '这张单子一共多少钱？' };

describe('取单号时库连不上 (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await boot('prepare');
  });

  afterAll(async () => {
    await app.close();
  });

  it('非流式 → 503，不是 500', async () => {
    const response = await request(app.getHttpServer())
      .post('/assistant/ask')
      .send(body)
      .expect(503);

    expect(response.body.message).toBe(UNAVAILABLE);
  });

  it('流式 → 还是普通的 JSON 503：这时响应头还没发出去', async () => {
    // prepare 在 flushHeaders 之前跑。所以库在这一步就挂掉时，流式端点
    // 仍然有能力返回一个**正常的 HTTP 错误** —— 而不是已经 200 了再塞一帧 error。
    // 这个顺序是刻意排的：能在写头之前发现的问题，就不该用流的语义去表达。
    const response = await request(app.getHttpServer())
      .post('/assistant/askStream')
      .send(body)
      .expect(503);

    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.message).toBe(UNAVAILABLE);
  });
});

describe('工具查询时库连不上 (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await boot('tool');
  });

  afterAll(async () => {
    await app.close();
  });

  it('非流式 → 503，而不是 200 +「信息不足」', async () => {
    const response = await request(app.getHttpServer())
      .post('/assistant/ask')
      .send(body)
      .expect(503);

    expect(response.body.message).toBe(UNAVAILABLE);
    // 说清楚它**不是**什么：降级成 200 的话，body 里会有一个 insufficient:true，
    // 和「这张单子确实查不到」长得一模一样。
    expect(response.body.insufficient).toBeUndefined();
  });

  it('流式 → 200 + error 帧，连接正常结束', async () => {
    // 走到这里时响应头早就发出去了（prepare 成功后立刻 flush），
    // 所以唯一能表达失败的通道是流里的 error 帧。直接抛的后果是连接断在半路，
    // 页面上的字永远停在「生成中」。
    const response = await request(app.getHttpServer())
      .post('/assistant/askStream')
      .send(body)
      .expect(200);

    const frames = parseSse(response.text);
    expect(frames.map((frame) => frame.event)).toEqual(['error']);
    expect(frames[0].data.message).toBe(UNAVAILABLE);
  });
});
