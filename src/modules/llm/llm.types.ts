/**
 * LLM 层的契约。
 *
 * 业务代码只认 `LlmProvider` 这个接口，不认任何具体厂商 —— 换厂商时改的是
 * `LlmModule` 里的一行绑定，不是 AssistantService。这条缝现在就要留出来，
 * 因为「先 mock 跑通、再换真模型」是这个项目的全部意义。
 *
 * ── 工具调用为什么长在这个接口上 ──
 *
 * 模型「要不要查、查什么」是模型自己的决定，所以这个决定必须发生在**模型协议层**，
 * 而不是业务代码里写一串 if。`tools` 进请求、`toolCalls` 进响应，就是协议层的全部形状。
 * 工具**怎么执行**与这里无关 —— 那是 AssistantService 的事，它拿到的是
 * 「模型想要什么」，不是「厂商的 JSON 长什么样」。
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 模型要求的一次工具调用。
 *
 * `arguments` 保持**厂商原样的 JSON 字符串**，不在这里解析。理由和 provider 不解析答案一样：
 * 参数可能是坏的，而「坏参数」属于工具执行层该处理并**回告模型**的事，
 * 不是协议层该崩掉的事。
 */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /**
   * role=assistant 且这一轮要求调用工具时，带上模型要的所有调用。
   * 回传给厂商时必须原样带上，否则它会看不到自己上一轮说了什么。
   */
  toolCalls?: LlmToolCall[];
  /** role=tool 时，这条结果对应哪一个调用。 */
  toolCallId?: string;
}

/** 给模型看的工具说明。`parameters` 是 JSON Schema。 */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequestOptions {
  /**
   * 取消信号。客户端断开连接时用它把还在跑的请求掐掉，
   * 否则用户已经关掉页面了，模型那边还在白烧 token。
   */
  signal?: AbortSignal;
  temperature?: number;
  /** 这一轮允许模型用的工具。不传 = 纯文本问答（老路径）。 */
  tools?: LlmToolSpec[];
}

export interface LlmCompletion {
  /** 模型返回的原始文本。调工具的那一轮通常是空串。注意：这里不做任何解析。 */
  text: string;
  /** 实际用的模型名。真实厂商在响应信封里给，所以和 text 一起返回。 */
  model: string;
  /** 这一轮模型要求调用的工具。空数组 = 它给了最终答案。 */
  toolCalls: LlmToolCall[];
}

/**
 * 流式事件。
 *
 * 文本是真的一段段到的；工具调用是**分片**到的（`index` 相同的是同一个调用，
 * name 和 arguments 各来一部分），所以 provider 会攒到流结束才发 `tool_call` 事件。
 * 这对调用方是好事：它拿到的永远是完整的调用，不用自己拼碎片。
 */
export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: LlmToolCall };

/**
 * 流式响应。
 *
 * 为什么是「先 await 拿到信封，再消费 events」，而不是直接返回一个裸的
 * `AsyncIterable`：两件真实存在的事只有这个形状能表达。
 *
 *   1. **模型名要在第一个 token 之前就确定。** 真实厂商把它放在响应信封里，
 *      和连接是否成功一起返回。裸迭代器要到消费时才知道。
 *   2. **鉴权/网络失败必须在写出任何字节之前抛出。** 裸迭代器的话，失败会发生在
 *      第一次 `.next()` 里 —— 那时 SSE 的响应头早就发出去了，再想返回 401/502 已经不可能。
 *
 * 这两个理由指向同一个原则：**能在流开始前确定的，就不要拖到流中间。**
 */
export interface LlmStream {
  model: string;
  events: AsyncIterable<LlmStreamEvent>;
}

export interface LlmProvider {
  /** 用于日志和响应里的来源标注，比如 'mock'、'deepseek' */
  readonly name: string;

  complete(
    messages: LlmMessage[],
    options?: LlmRequestOptions,
  ): Promise<LlmCompletion>;

  stream(
    messages: LlmMessage[],
    options?: LlmRequestOptions,
  ): Promise<LlmStream>;
}

/** DI 用的注入令牌。业务代码写 @Inject(LLM_PROVIDER)，不写具体实现类。 */
export const LLM_PROVIDER = 'LLM_PROVIDER';
