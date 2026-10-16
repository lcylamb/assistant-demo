import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
} from '../llm/llm.types.js';
import type { AskDto } from './ask.dto.js';
import type { AskResult, AssistantStreamEvent } from './ask.types.js';
import { buildExpenseContext, type ExpenseContext } from './expense-context.js';
import { parseAnswer } from './parse-answer.js';
import { partialConclusion } from './stream-parse.js';

/**
 * 系统提示词。
 *
 * 三条约束各自对应代码里的一个动作，不是随便写的客气话：
 *   · 第 1、2 条 → 模型若违反，evidence 里会出现 availableFields 之外的字段，
 *                  `dropUnknownEvidence` 会把它抓出来
 *   · 第 3 条   → 对应 insufficient 这个字段，也是「数据里没有」和「模型不知道」
 *                  在接口层面被分开的原因
 *   · 第 4 条   → 对应 parseAnswer；写成只输出 JSON，就不用在解析器里处理
 *                  长篇自然语言里夹带 JSON 的花样
 */
const SYSTEM_PROMPT = `你是一个报销单查询助手。

规则：
1. 只能依据「报销单数据」里出现过的事实回答。不要推测，不要补充数据里没有的内容。
2. 回答引用的每一个字段，都必须来自「可引用字段」清单，不要自己发明字段名。
3. 数据不足以回答问题时，把 insufficient 设为 true，并在 conclusion 里说清楚缺什么。
4. 只输出一个 JSON 对象。不要写解释，不要加 Markdown 代码块。

输出格式：
{"conclusion": "一句话结论（中文）", "evidence": ["用到的字段路径"], "insufficient": false}`;

/**
 * 一次提问的「上半场」：取数、摊平、组 prompt。
 *
 * 单独成型的理由是**两条端点必须共用它**。`ask()` 和 `askStream()` 各自组一遍
 * prompt 的话，两边会慢慢长歪 —— 而症状是「流式和非流式答得不一样」，
 * 这种 bug 极难查，因为两边单看都「能跑」。
 *
 * 它还顺带解决一个时序问题：取数会抛 404，**必须在 SSE 的响应头写出去之前完成**。
 * 头一发，就再也没法返回一个正常的 JSON 错误了。
 */
export interface PreparedAsk {
  code: string;
  availableFields: string[];
  messages: LlmMessage[];
}

/**
 * 幻觉告警的固定开头。
 *
 * 单独导出成常量，是因为评测**数这条日志**来算幻觉率 ——
 * 它已经是评测的输入之一了。如果它只是一句随手写的字符串，
 * 哪天有人把「引用了不存在的字段」改成「引用了未知字段」，
 * 评测会静默地一直报 0% 幻觉，而且没有任何地方会提示这件事。
 */
export const HALLUCINATION_WARN = '模型引用了不存在的字段';

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  /**
   * 问一句，拿回结构化答案。
   *
   * 五个步骤，每一步都对应一个可能出错的地方，且错的种类不同：
   *   取数（单号不存在）→ 组 prompt（不涉及失败）→ 调用（网络/鉴权）
   *   → 解析（模型没按格式答）→ 字段校验（模型编了字段）
   * 前四种各有各的异常，最后一种只记日志 —— 理由见 dropUnknownEvidence。
   */
  async ask(dto: AskDto): Promise<AskResult> {
    const prepared = await this.prepare(dto);

    const completion = await this.llm.complete(prepared.messages);
    this.logger.log(
      `[${this.llm.name}] ${completion.model} 回答 ${dto.code}（${completion.text.length} 字）`,
    );

    const result = this.settle(completion.text, prepared, dto.code);
    if (!result.ok) throw new BadGatewayException(result.message);
    return result.value;
  }

  /**
   * 流式版。
   *
   * ⚠️ 这是**服务层**，它不知道 SSE 长什么样 —— 它只 yield 事件。
   * `event:` / `data:` 这些分帧语法是 HTTP 的事，归 controller 管。
   * 混在一起的话，将来想在 WebSocket 上复用这条流，就得把 HTTP 的东西撕出来。
   */
  async *streamAnswer(
    prepared: PreparedAsk,
    signal?: AbortSignal,
  ): AsyncGenerator<AssistantStreamEvent> {
    let buffer = '';
    let emitted = '';

    try {
      const stream = await this.llm.stream(prepared.messages, { signal });

      for await (const chunk of stream.chunks) {
        buffer += chunk;

        const partial = partialConclusion(buffer);

        // 理论上前缀关系必然成立（重扫是幂等的，见 stream-parse.ts）。
        // 真不成立就说明解析器有 bug —— 宁可不吐，也不能吐错：
        // 用户看到一段后来被最终结果推翻的字，比晚 50ms 看到更难解释。
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
      this.logger.error(
        `流式调用失败：${error instanceof Error ? error.message : String(error)}`,
      );
      yield { type: 'error', message: '模型调用失败，请重试' };
      return;
    }

    if (signal?.aborted) {
      this.logger.log(`客户端已断开，${prepared.code} 的流提前结束`);
      return;
    }

    // ⚠️ 最终结果走的是和非流式**完全相同**的收口逻辑。
    // 不走这一步的话，增量阶段吐出去的字就成了绕过校验的后门：
    // 用户看到的是没经过格式校验、也没过防幻觉校验的文本。
    const result = this.settle(buffer, prepared, prepared.code);
    if (!result.ok) {
      yield { type: 'error', message: result.message };
      return;
    }

    this.logger.log(`流式回答完成 ${prepared.code}（增量 ${emitted.length} 字）`);
    yield { type: 'done', data: result.value };
  }

  /** 取数 + 摊平 + 组 prompt。会抛 404，所以必须在写响应头之前调用。 */
  async prepare(dto: AskDto): Promise<PreparedAsk> {
    const context = await this.loadContext(dto.code);
    return {
      code: dto.code,
      availableFields: context.availableFields,
      messages: buildMessages(context, dto.question),
    };
  }

  /** 取数并摊平。找不到单子就是 404 —— 这不是模型的失败，不该报成 5xx。 */
  private async loadContext(code: string): Promise<ExpenseContext> {
    const expense = await this.prisma.expense.findUnique({
      where: { code },
      include: { items: { orderBy: { spentOn: 'asc' } } },
    });

    if (!expense) {
      throw new NotFoundException(`没有找到编号为 ${code} 的报销单`);
    }

    return buildExpenseContext(expense);
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
    prepared: PreparedAsk,
    code: string,
  ): { ok: true; value: AskResult } | { ok: false; message: string } {
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
      value: this.dropUnknownEvidence(
        parsed.value,
        prepared.availableFields,
        code,
      ),
    };
  }

  /**
   * 剔除模型编出来的字段路径。
   *
   * 为什么**不**直接报错：字段名里出现一个不存在的路径，说明这句结论很可能站不住，
   * 但它也可能只是顺手多写了一个（真实模型很常见）。为此把整个请求判成失败，
   * 等于让一次措辞瑕疵变成用户看到的错误页。
   *
   * 折中是：从 evidence 里剔掉，保证**用户看到的依据一定真实存在**，
   * 同时在日志里留下 warn —— 评测就靠数这条日志来算幻觉率。
   *
   * ⚠️ 诚实边界：剔除只保证 evidence 不撒谎，**不保证 conclusion 因此就对了**。
   * 结论对不对是评测要回答的问题，不是这道校验能回答的。
   */
  private dropUnknownEvidence(
    result: AskResult,
    availableFields: string[],
    code: string,
  ): AskResult {
    const known = new Set(availableFields);
    const unknown = result.evidence.filter((field) => !known.has(field));
    if (unknown.length === 0) return result;

    this.logger.warn(
      `${HALLUCINATION_WARN}，已剔除：[${unknown.join(', ')}]（单号 ${code}）` +
        `｜可用字段共 ${availableFields.length} 个`,
    );

    return { ...result, evidence: result.evidence.filter((f) => known.has(f)) };
  }
}

function buildMessages(context: ExpenseContext, question: string): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '## 报销单数据',
        '```json',
        JSON.stringify(context.record, null, 2),
        '```',
        '',
        '## 可引用字段',
        context.availableFields.join(', '),
        '',
        '## 问题',
        question,
      ].join('\n'),
    },
  ];
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字）`;
}
