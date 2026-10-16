/**
 * LLM 层的契约。
 *
 * 业务代码只认 `LlmProvider` 这个接口，不认任何具体厂商 —— 换厂商时改的是
 * `LlmModule` 里的一行绑定，不是 AssistantService。这条缝现在就要留出来，
 * 因为「先 mock 跑通、再换真模型」是这个项目的全部意义。
 */

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmRequestOptions {
  /**
   * 取消信号。客户端断开连接时用它把还在跑的请求掐掉，
   * 否则用户已经关掉页面了，模型那边还在白烧 token。
   */
  signal?: AbortSignal;
  temperature?: number;
}

export interface LlmCompletion {
  /** 模型返回的原始文本。注意：这里不做任何解析 —— 解析是调用方的事。 */
  text: string;
  /** 实际用的模型名。真实厂商在响应信封里给，所以和 text 一起返回。 */
  model: string;
}

/**
 * 流式响应。
 *
 * 为什么是「先 await 拿到信封，再消费 chunks」，而不是直接返回一个裸的
 * `AsyncIterable<string>`：两件真实存在的事只有这个形状能表达。
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
  chunks: AsyncIterable<string>;
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
