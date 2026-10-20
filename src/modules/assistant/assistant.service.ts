import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DailyQuotaService } from '../llm/daily-quota.service.js';
import {
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
} from '../llm/llm.types.js';
import type { AskDto } from './ask.dto.js';
import type {
  AgentStep,
  AskResult,
  AssistantStreamEvent,
  ParsedAnswer,
} from './ask.types.js';
import { parseAnswer } from './parse-answer.js';
import { partialConclusion } from './stream-parse.js';
import { TOOL_SPECS, findTool, type ToolOutcome } from './tools.js';

/**
 * 系统提示词。
 *
 * 和「把数据塞进 prompt」那一版相比，多出来的第 1 条是这次改造的核心：
 * **数据不在 prompt 里，模型要靠工具去拿**。这句话必须写，否则模型会凭常识编。
 *
 * 三条约束各自对应代码里的一个动作：
 *   · 第 2 条 → `dropUnknownEvidence`：引用了本次**没查过**的字段就剔除并记 warn
 *   · 第 3 条 → 对应 insufficient，也是「数据里没有」和「模型不知道」在接口层面分开的原因
 *   · 第 4 条 → 对应 parseAnswer；写成只输出 JSON，就不用在解析器里处理长篇小说
 */
const SYSTEM_PROMPT = `你是一个报销单查询助手。

规则：
1. 你看不到报销单数据本身。需要什么就调用工具去查，不要凭常识推测。
2. 回答引用的每一个字段，都必须来自工具本次返回过的字段路径（例如 items[0].name）。
3. 工具返回的数据不足以回答问题时，把 insufficient 设为 true，并在 conclusion 里说清楚缺什么。
4. 拿到数据后，只输出一个 JSON 对象。不要写解释，不要加 Markdown 代码块。

输出格式：
{"conclusion": "一句话结论（中文）", "evidence": ["用到的字段路径"], "insufficient": false}`;

/**
 * 幻觉告警的固定开头。
 *
 * 单独导出成常量，是因为评测**数这条日志**来算幻觉率 ——
 * 它已经是评测的输入之一了。如果它只是一句随手写的字符串，
 * 哪天有人把「引用了不存在的字段」改成「引用了未知字段」，
 * 评测会静默地一直报 0% 幻觉，而且没有任何地方会提示这件事。
 */
export const HALLUCINATION_WARN = '模型引用了不存在的字段';

/**
 * 额度用完时给用户看的话。
 *
 * 单独成常量是因为它出现在**两条端点**上，而两条路的拒绝方式不同 ——
 * 非流式抛 429，流式只能往流里发一个 error 事件（响应头早就发出去了）。
 * 话术必须是同一句：同一个原因在页面上有两种说法，读起来像两个不同的问题。
 */
const QUOTA_MESSAGE = '今天的演示额度用完了，明天再来。';

/**
 * 一次提问最多允许几轮「模型调工具 → 我们回结果」。
 *
 * 有上限不是怕模型笨，是怕它**循环**：一旦模型每次都要求调工具、每次都拿不到想要的东西，
 * 没有上限的话这个请求会一直烧 token 直到超时。4 轮对三类问题绰绰有余
 * （实测最多 2 轮：一轮并行调 2~3 个工具，第二轮出答案）。
 */
const MAX_TOOL_STEPS = 4;

/**
 * 一次提问的会话状态。
 *
 * 为什么不是把数据放进 prompt：`expenseId` 是**服务端绑定**的，模型碰不到。
 * 工具只拿得到它，所以模型能查的范围由这次请求决定，不能由它的输出决定。
 *
 * `fields` 是本次**实际查过**的字段路径集合，防幻觉的白名单从它来 ——
 * 不再是「这张单子有哪些字段」，而是「模型这次真的看过哪些字段」。
 * 后者更严：它连「没查就敢引用」也拦得住。
 */
export interface AgentSession {
  code: string;
  expenseId: string;
  messages: LlmMessage[];
  fields: Set<string>;
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly quota: DailyQuotaService,
  ) {}

  /**
   * 问一句，拿回结构化答案。
   *
   * 每一轮模型调用都是一次「它自己决定下一步」：要工具就调，不要就收口。
   * 失败的种类仍然分得开 —— 取数（404）、额度（429）、模型/厂商（502）、
   * 格式（502，但日志里写着原因）。
   */
  async ask(dto: AskDto): Promise<AskResult> {
    const session = await this.prepare(dto);
    const trace: AgentStep[] = [];

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      this.assertQuota();

      let completion;
      try {
        completion = await this.llm.complete(session.messages, {
          tools: TOOL_SPECS,
        });
      } catch (error) {
        this.logModelFailure(error);
        throw new BadGatewayException('模型调用失败，请重试');
      }

      if (completion.toolCalls.length === 0) {
        this.logger.log(
          `[${this.llm.name}] ${completion.model} 回答 ${dto.code}` +
            `（${completion.text.length} 字，工具 ${trace.length} 次）`,
        );
        const result = this.settle(completion.text, session);
        if (!result.ok) throw new BadGatewayException(result.message);
        return { ...result.value, trace };
      }

      await this.executeToolCalls(session, completion.text, completion.toolCalls, trace);
    }

    throw new BadGatewayException('模型反复调用工具，已停止');
  }

  /**
   * 流式版。
   *
   * ⚠️ 这是**服务层**，它不知道 SSE 长什么样 —— 它只 yield 事件。
   * `event:` / `data:` 这些分帧语法是 HTTP 的事，归 controller 管。
   *
   * 和 `ask()` 是同一个循环，只是每轮换成流式读。文本一边到一边往外吐；
   * 工具调用是攒齐了才执行（碎片没法执行），执行完进入下一轮。
   */
  async *streamAnswer(
    session: AgentSession,
    signal?: AbortSignal,
  ): AsyncGenerator<AssistantStreamEvent> {
    const trace: AgentStep[] = [];
    let emitted = '';

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      // 额度检查在**这里**，不能像 ask() 那样抛异常：controller 早就把 SSE 的
      // 响应头发给浏览器了，那时再抛只会把连接搞断，用户什么也看不到。
      // 所以超限的表示方式是流里的一个 error 事件 —— 前端已经会渲染它。
      if (!this.quota.consume()) {
        yield { type: 'error', message: QUOTA_MESSAGE };
        return;
      }

      let stream;
      try {
        stream = await this.llm.stream(session.messages, {
          tools: TOOL_SPECS,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          this.logger.log(`客户端已断开，${session.code} 的流提前结束`);
          return;
        }
        this.logModelFailure(error);
        yield { type: 'error', message: '模型调用失败，请重试' };
        return;
      }

      let text = '';
      let toolPhase = false;
      const calls: LlmToolCall[] = [];

      try {
        for await (const event of stream.events) {
          if (event.type === 'tool_call') {
            toolPhase = true;
            calls.push(event.call);
            continue;
          }

          text += event.text;

          // 工具轮里模型偶尔会先说一句人话（jsonMode 关掉时尤其常见）。
          // 那不是答案，不能往用户那边吐 —— 否则最终结论会和已经显示的字对不上。
          if (toolPhase) continue;

          const partial = partialConclusion(text);

          // 理论上前缀关系必然成立（重扫是幂等的，见 stream-parse.ts）。
          // 真不成立就说明解析器有 bug —— 宁可不吐，也不能吐错。
          if (!partial.startsWith(emitted)) {
            this.logger.warn('增量解析结果不是单调的，本块丢弃（stream-parse 可能有 bug）');
            continue;
          }

          if (partial.length > emitted.length) {
            yield { type: 'delta', text: partial.slice(emitted.length) };
            emitted = partial;
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          this.logger.log(`客户端已断开，${session.code} 的流提前结束`);
          return;
        }
        this.logModelFailure(error);
        yield { type: 'error', message: '模型调用失败，请重试' };
        return;
      }

      if (signal?.aborted) {
        this.logger.log(`客户端已断开，${session.code} 的流提前结束`);
        return;
      }

      if (calls.length === 0) {
        // ⚠️ 最终结果走的是和非流式**完全相同**的收口逻辑。
        // 不走这一步的话，增量阶段吐出去的字就成了绕过校验的后门。
        const result = this.settle(text, session);
        if (!result.ok) {
          yield { type: 'error', message: result.message };
          return;
        }

        this.logger.log(
          `流式回答完成 ${session.code}（增量 ${emitted.length} 字，工具 ${trace.length} 次）`,
        );
        yield { type: 'done', data: { ...result.value, trace } };
        return;
      }

      // 这一轮已经吐出过字的极端情况：模型先说了半句、随后又要调工具。
      // 已经发出去的字收不回来，只能把 `emitted` 归零，让最终答案还能正常显示；
      // 代价是页面上可能多出一句前言 —— 记一条 warn，评测那边会用增量断言抓住它。
      if (emitted !== '') {
        this.logger.warn(
          `工具轮里已经向客户端吐出过文本（${emitted.length} 字），最终结论可能与已显示内容不一致`,
        );
        emitted = '';
      }

      await this.executeToolCalls(session, text, calls, trace);
    }

    yield { type: 'error', message: '模型反复调用工具，已停止' };
  }

  /**
   * 取数 + 组 prompt。会抛 404，所以必须在写响应头之前调用。
   *
   * 这里**只查 id**，不把数据读出来 —— 数据由模型决定要不要查、查哪一块。
   * 这也顺带把「单号存不存在」和「模型要查什么」两件事分开了：
   * 前者是请求合法性，必须在流开始前判；后者是模型的决定，发生在流中间。
   */
  async prepare(dto: AskDto): Promise<AgentSession> {
    const expense = await this.prisma.expense.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });

    if (!expense) {
      throw new NotFoundException(`没有找到编号为 ${dto.code} 的报销单`);
    }

    return {
      code: dto.code,
      expenseId: expense.id,
      messages: buildMessages(dto.code, dto.question),
      fields: new Set<string>(),
    };
  }

  private assertQuota(): void {
    if (!this.quota.consume()) {
      throw new HttpException(QUOTA_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * 执行一轮工具调用，并把结果写回对话。
   *
   * 三件事这里必须做对：
   *   1. assistant 那条消息要带 `toolCalls` —— 厂商靠它把下一轮的 tool 结果对上号；
   *   2. 每条结果都带 `toolCallId`，配对依据是 id 不是函数名（并行调同一个工具时，
   *      光靠名字分不清哪条结果属于哪次调用）；
   *   3. **无论成功失败都要回一条 tool 消息**。漏掉任何一条，下一轮请求的结构就不完整，
   *      厂商会直接 400 —— 错误会出现在离病因很远的地方。
   */
  private async executeToolCalls(
    session: AgentSession,
    text: string,
    calls: LlmToolCall[],
    trace: AgentStep[],
  ): Promise<void> {
    session.messages.push({ role: 'assistant', content: text, toolCalls: calls });

    for (const call of calls) {
      const startedAt = Date.now();
      const tool = findTool(call.name);
      let outcome: ToolOutcome;

      if (!tool) {
        // 模型报了一个不存在的工具名（幻觉的一种）。回告它，别崩。
        this.logger.warn(`模型请求了不存在的工具：${call.name}`);
        outcome = {
          ok: false,
          payload: { error: `没有名为 ${call.name} 的工具，请使用已有工具或直接说明信息不足` },
          fields: [],
        };
      } else {
        try {
          outcome = await tool.run({
            expenseId: session.expenseId,
            prisma: this.prisma,
          });
        } catch (error) {
          this.logger.error(
            `工具 ${call.name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
          );
          outcome = {
            ok: false,
            payload: { error: '工具执行失败，请换一种方式或直接说明信息不足' },
            fields: [],
          };
        }
      }

      for (const field of outcome.fields) session.fields.add(field);

      session.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(outcome.payload),
      });

      trace.push({ tool: call.name, ok: outcome.ok });

      // 打点：工具名、耗时、返回了多少个可引用字段。
      // 评测不看这几行（它看 trace），排查「怎么答得这么慢」时看它们。
      this.logger.log(
        `工具 ${call.name} ${outcome.ok ? '完成' : '失败'}` +
          `（${Date.now() - startedAt} ms，${outcome.fields.length} 个可引用字段）`,
      );
    }
  }

  /**
   * 收口：解析 + 防幻觉。**两条端点唯一的共同出口。**
   *
   * 返回判别联合而不是直接抛，是因为它服务两种调用方式：
   * 非流式要抛异常（让 Nest 的异常过滤器接管），流式要 yield 一个 error 事件
   * （那时响应头早就发出去了，抛异常只会把连接搞断）。
   */
  private settle(
    raw: string,
    session: AgentSession,
  ): { ok: true; value: ParsedAnswer } | { ok: false; message: string } {
    const parsed = parseAnswer(raw);
    if (!parsed.ok) {
      // 把原因和原文一起记下来 —— 只报「格式异常」的话，没法判断是提示词要改
      // 还是模型这次的偶发抖动。原文截断是为了不让日志被一整段文本淹没。
      this.logger.warn(
        `模型回答格式异常：${parsed.reason}｜原文：${truncate(raw)}`,
      );
      return { ok: false, message: '模型回答格式异常，请重试' };
    }

    return {
      ok: true,
      value: this.dropUnknownEvidence(parsed.value, session.fields, session.code),
    };
  }

  /**
   * 剔除模型编出来的字段路径。
   *
   * 白名单是**本次实际查过**的字段（session.fields），不是整张单子的字段全集。
   * 这个区别有意义：模型没查审批记录却引用 `rejectReason`，即使这个字段在库里存在，
   * 它也是在拿没有依据的东西说话 —— 该被剔掉，并且该记一笔。
   *
   * 为什么**不**直接报错：字段名里出现一个不存在的路径，说明这句结论很可能站不住，
   * 但它也可能只是顺手多写了一个（真实模型很常见）。为此把整个请求判成失败，
   * 等于让一次措辞瑕疵变成用户看到的错误页。
   */
  private dropUnknownEvidence(
    result: ParsedAnswer,
    known: Set<string>,
    code: string,
  ): ParsedAnswer {
    const unknown = result.evidence.filter((field) => !known.has(field));
    if (unknown.length === 0) return result;

    this.logger.warn(
      `${HALLUCINATION_WARN}，已剔除：[${unknown.join(', ')}]（单号 ${code}）` +
        `｜本次实际查过 ${known.size} 个字段`,
    );

    return { ...result, evidence: result.evidence.filter((f) => known.has(f)) };
  }

  private logModelFailure(error: unknown): void {
    // ⚠️ 这一层在接真模型之前是**不需要**的，因为假模型不会失败。
    // 真实厂商会：密钥过期、余额用尽、超时、502。不接住的话它变成一个 500，
    // 而 500 的语义是「服务端有 bug」—— 上游看到就会去翻代码，方向从一开始就错了。
    this.logger.error(
      `调用模型失败（${this.llm.name}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 组第一轮对话。
 *
 * 这里**没有数据**，只有单号和问题 —— 数据要靠模型自己调工具去拿。
 * 单号本身是必要的（它让结论能说清「哪张单子」），但不是查询条件：
 * 工具的范围由服务端绑定，模型改不了。
 */
function buildMessages(code: string, question: string): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: ['## 报销单单号', code, '', '## 问题', question].join('\n'),
    },
  ];
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字）`;
}
