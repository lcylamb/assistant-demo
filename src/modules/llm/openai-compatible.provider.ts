import { Logger } from '@nestjs/common';
import type {
  LlmCompletion,
  LlmMessage,
  LlmProvider,
  LlmRequestOptions,
  LlmStream,
  LlmStreamEvent,
  LlmToolCall,
} from './llm.types.js';
import {
  parseVendorDelta,
  parseVendorMessage,
  sseDataFrames,
  type VendorToolCallDelta,
} from './openai-sse.js';

/**
 * 真模型。走 OpenAI 的 `/chat/completions` 协议。
 *
 * ── 为什么是「协议」而不是某个厂商 ──
 *
 * 这个类里没有一处写着 DeepSeek、通义或者 Kimi 的名字，因为**厂商由配置决定**：
 * `LLM_BASE_URL` 指哪台机器、`LLM_MODEL` 要哪个模型。换厂商改的是 `.env`，不是代码。
 * 这几家都说同一套协议，是这个类能长得这么薄的全部原因。
 *
 * ── 和假模型的关系 ──
 *
 * `MockLlmProvider` 不删，它退回成**测试夹具**。两条理由：e2e 不该依赖网络和额度；
 * 而且真实模型的输出不可复现，只有假模型能对「管道」写死断言。
 * 两个实现摆在同一个接口后面，正好也是这个接口当初留出来的用意。
 *
 * ── 这个类不做什么 ──
 *
 * 它**不解析答案**。返回的就是模型原样吐的文本，可能带着 ``` 代码块、可能带着寒暄，
 * 解析和校验是 `assistant.service.ts` 的事。在 provider 里顺手 JSON.parse 一下很诱人，
 * 但那样「模型没按格式答」这个失败模式就会被埋在换厂商时最容易改坏的地方。
 */
export interface OpenAiCompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * 单次调用的超时。非流式是整个请求的上限；流式里它管两件事：
   * 等第一个字，以及相邻两帧之间最多沉默多久（见 `nextFrame()`）。
   */
  timeoutMs: number;
  /**
   * 厂商临时失败（连不上、429、5xx）时最多试几次，**含第一次**。
   * 只在还没向客户端吐出任何字之前重试 —— 见 `stream()` 里那段注释。
   * 1 = 关掉重试。
   */
  maxAttempts: number;
  /**
   * 输出上限。答案是一句 JSON，这个值给的是「被刷时的爆炸半径」。
   */
  maxTokens: number;
  /**
   * 让厂商强制输出合法 JSON（`response_format: json_object`）。
   *
   * ⚠️ 这是**收窄**不是**保证**。真开着的价值在于把「模型偶尔写段寒暄再给 JSON」
   * 这种漂移挡在厂商侧；但它替代不了 `parseAnswer` 那道校验 ——
   * 合法 JSON 照样可以是错的答案、可以引用不存在的字段。
   * 约束和校验是两层，撤掉任何一层都会在换模型那天暴露。
   *
   * 少数 OpenAI 兼容服务不支持这个字段，所以留了开关（`LLM_JSON_MODE=false`）。
   */
  jsonMode: boolean;
  /**
   * 流式请求里是否让厂商在末尾额外发一帧用量
   * （OpenAI 协议的 `stream_options.include_usage`）。
   *
   * 默认开：不打开的话流式端点永远拿不到 token 数，而流式恰好是页面真正在用的那条路。
   * 少数兼容实现不认这个字段、会直接 400，所以留了开关（`LLM_STREAM_USAGE=false`）。
   */
  streamUsage: boolean;
}

/**
 * 默认值。导出给 `llm.module.ts` 用，而不是在那边各写一份字面量 ——
 * 两处的数字迟早会走岔，而走岔的症状是「文档写着 30 秒，实际在等 15 秒」。
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 退避：第一次 0~250 ms，第二次 0~500 ms（满抖动），封顶 2 s。
 *
 * 为什么上限这么短：请求头上还挂着一个人。厂商说「一分钟后再来」时，
 * 让用户盯着「生成中」转一分钟，比直接告诉他这次失败了更糟。
 */
const RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

/**
 * 哪些状态码值得再试一次。
 *
 * 全是「这一下不行，等会儿可能就行」：限流、过载、网关抖了。
 * 4xx 里的鉴权、余额、参数错误不在此列 —— 再试一百次也是同样的结果，
 * 只是多花时间、多一次被厂商计费的可能。
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 厂商侧的失败，顺带记着「值不值得重试」。
 *
 * 用一个类而不是在调用处现判：判定依据（状态码、错误名）只有 `post()` 拿得到，
 * 而重试的位置在更外层。让错误自己带着这个结论走，比在外面猜错误消息里有没有
 * 「超时」两个字可靠得多 —— 后者会在某次改文案时悄悄失效。
 */
class VendorError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** 厂商用 `Retry-After` 指定的等待时间。有就用它，没有才走自己的退避。 */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'VendorError';
  }
}

/**
 * 流式请求里「内部掐断」的原因。`null` = 没有内部掐断，那要是 aborted 就是调用方取消的。
 * 见 `stream()` 里那段注释。
 */
type InternalAbort = 'first-token' | 'stalled' | null;

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';

  private readonly logger = new Logger(OpenAiCompatibleProvider.name);
  private readonly config: OpenAiCompatibleConfig;
  private readonly endpoint: string;

  constructor(config: OpenAiCompatibleConfig) {
    // 缺配置就**在启动时炸**，不要等第一次提问才失败。
    // 这和 llm.module.ts 里 default 分支抛异常是同一条原则：
    // 「以为接了真模型、其实一直在跑假数据」是最坏的一种失败，宁可起不来。
    const problems: string[] = [];
    if (!config.apiKey.trim()) problems.push('LLM_API_KEY');
    if (!config.baseUrl.trim()) problems.push('LLM_BASE_URL');
    if (!config.model.trim()) problems.push('LLM_MODEL');
    if (problems.length > 0) {
      throw new Error(
        `LLM_PROVIDER=openai 时必须配置：${problems.join('、')}。` +
          '（只放进本地 .env 和部署平台的 secret，不要进仓库。）',
      );
    }

    // 末尾斜杠去掉，否则 `https://x/v1/` + `/chat/completions` 会拼出双斜杠。
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') };
    this.endpoint = `${this.config.baseUrl}/chat/completions`;
  }

  async complete(
    messages: LlmMessage[],
    options?: LlmRequestOptions,
  ): Promise<LlmCompletion> {
    // 非流式可以整次重试：还没向外写过任何东西，重试对调用方不可见。
    // 流式不行，那条边界在 `stream()` 里，卡在「第一个字」上。
    const response = await this.requestWithRetry(
      () => this.post(messages, options, false),
      options?.signal,
    );

    const body = (await response.json().catch(() => null)) as unknown;
    const message = parseVendorMessage(body);

    // 只有工具调用、没有文本是**正常**的一轮 —— 模型决定先查数据再回答。
    // 所以「两个都空」才算异常。
    if (message.text === '' && message.toolCalls.length === 0) {
      throw new Error(
        `厂商响应里既没有 choices[0].message.content 也没有 tool_calls：${truncate(stringify(body))}`,
      );
    }

    return {
      text: message.text,
      model: message.model ?? this.config.model,
      toolCalls: message.toolCalls,
      // 没报就是 undefined，不补 0：调用方靠它区分「用量为零」和「厂商没说」。
      usage: message.usage,
    };
  }

  /**
   * 流式版。
   *
   * ── 这个方法是整个文件里唯一有难度的地方 ──
   *
   * `LlmStream` 的契约要求 **model 在返回之前就确定**（见 llm.types.ts 里那段注释）。
   * 但 OpenAI 兼容协议的模型名不在 HTTP 响应信封里 —— 它在**每一个数据帧**里。
   * 于是只能：先把响应拿到手、再往前拉几帧，拉到第一段有内容的帧为止，
   * 顺便把模型名从帧里捡出来，然后才返回。
   *
   * 这一步顺带买到另一件更要紧的东西：**鉴权失败和连不上都在这里抛出去**，
   * 而不是拖到流中间。所以客户端拿到的是一个干净的 error 事件，
   * 不是「半句被截断的答案 + 一个不知道怎么回事的结束」。
   *
   * ── 手拉迭代器，而不是 for await ──
   *
   * 下面刻意用 `iterator.next()` 而不是 `for await (… of …) break`：`for await` 提前
   * `break` 会调用生成器的 `return()`，那会一路走到 `sseDataFrames` 的 finally，
   * 把**我们还打算继续读**的 body 取消掉。这个坑的症状是「第一帧之后就再也没有下文」。
   */
  async stream(
    messages: LlmMessage[],
    options?: LlmRequestOptions,
  ): Promise<LlmStream> {
    /**
     * 调用方的取消信号要能传到**当前那一次尝试**上。
     *
     * 重试会换一个新的 controller（上一次的已经 abort 了，不能复用），
     * 所以外层持有一个 `current` 指针，监听器只管掐它指向的那一个。
     * 直接闭包捕获第一个 controller 的话，重试之后用户关页面就掐不断了。
     */
    const outer = options?.signal;
    let current: AbortController | null = null;
    const forward = () => current?.abort(outer?.reason);
    if (outer && !outer.aborted) {
      outer.addEventListener('abort', forward, { once: true });
    }
    // 这个监听器要在**流结束之前**一直挂着（中途断开必须能传到厂商那边），
    // 所以摘除放在 `streamEvents` 的 finally 里，不能像 complete() 那样就地摘。
    const detach = () => outer?.removeEventListener('abort', forward);

    /**
     * 重试的边界在**第一个字之前**。
     *
     * `prime()` 返回之前没有任何字节被交给调用方 —— 它只是在等响应头、等首帧。
     * 所以这一段失败（连不上、429、503、首帧不来）可以整次重来，客户端不会看到
     * 重复内容。一旦 `prime()` 返回，流就开始往外吐字了，那时再重试只会把同一段
     * 话吐两遍，所以下面消费事件的循环**不在**重试范围里。
     *
     * 工具碎片累加器必须**每次尝试新建**：失败的那次可能已经收了几片，
     * 带进下一次就会拼出一个不存在的调用、或者把参数接重。
     */
    for (let attempt = 1; ; attempt += 1) {
      // 自己拿一个 controller 而不是直接用 options.signal：首帧超时要能掐掉这条连接，
      // 而调用方的 signal 我们不能替它 abort。
      const controller = new AbortController();
      current = controller;
      if (outer?.aborted) controller.abort(outer.reason);

      /**
       * 「调用方自己取消的」和「出错了」是两件不同的事，分开判。
       *
       * 这件事必须**只判一次、只在一个地方判**：四条路径（连不上、首帧不来、
       * 迭代中途断开、正常读完）都可能撞上它，每处各写一遍的话，
       * 迟早有一处把「用户关掉了页面」报成错误事件，而那时连接早就没了。
       *
       * 用可变对象而不是一个 `let`：时限是在别的函数里触发的，
       * 这个标志要跨出那次调用，好让 catch 分得清「内部掐断」和「调用方取消」——
       * 两者都会让 `controller.signal.aborted` 变成 true。
       *
       * 内部掐断分两种，报错话术不一样：
       *   · `first-token`：连「模型开口了」都没等到（多半是厂商过载或鉴权）。
       *   · `stalled`：先吐了字，然后彻底沉默（多半是连接被半死的中转挂住）。
       * 两者分开，是因为看到日志的人要去的方向不同。
       */
      const timing: { abortReason: InternalAbort } = { abortReason: null };
      const callerAborted = () =>
        controller.signal.aborted && timing.abortReason === null;

      // 工具调用的碎片流会在两个阶段被读到：`prime()` 为了确定模型名会先拉几帧，
      // 剩下的在消费端继续读。所以累加器必须**跨这两个阶段**存在，
      // 否则第一批碎片会被丢掉 —— 症状是「模型说它调了工具，服务端却一个都没执行」。
      const toolCalls = new ToolCallAccumulator();

      try {
        const primed = await this.prime(
          messages,
          options,
          controller,
          timing,
          toolCalls,
        );
        // 到这里模型名一定有了：要么从帧里捡到，要么退回配置值。
        // ⚠️ 退回来说明厂商一个 model 字段都没给，那这条流的来源就只能靠配置解释了。
        return {
          model: primed.model,
          events: this.streamEvents(
            primed.iterator,
            primed.first,
            toolCalls,
            detach,
            callerAborted,
            controller,
            timing,
          ),
        };
      } catch (error) {
        // 调用方主动取消不是失败 —— 和假模型的行为保持一致：
        // 干净地结束，不往一条已经关掉的连接上写错误事件。
        if (callerAborted()) {
          detach();
          this.logger.log('调用方已取消，模型请求提前结束');
          return { model: this.config.model, events: emptyEvents() };
        }

        const delay =
          attempt < this.config.maxAttempts
            ? this.retryDelayMs(error, attempt)
            : null;
        if (delay !== null) {
          this.logger.warn(
            `模型调用失败，${delay} ms 后重试（第 ${attempt} 次尝试）：${messageOf(error)}`,
          );
          // 退避期间用户可能关掉页面。sleep 会在取消时提前醒来，
          // 下一圈的 `outer.aborted` 会立刻把这次尝试掐掉，走出上面的分支。
          await sleep(delay, outer);
          continue;
        }

        detach();
        if (timing.abortReason === 'first-token') {
          throw new VendorError(
            `等待模型第一个字超时（${this.config.timeoutMs} ms）`,
            false,
          );
        }
        throw error;
      }
    }
  }

  /**
   * 拿到响应、拉够帧、定下模型名。
   *
   * ── 时限从哪一刻开始算 ──
   *
   * **从发请求那一刻**，不是从响应头到齐那一刻。这两个时刻之间的差别是真实存在的：
   * 厂商接下连接然后什么都不回（过载，或者一台半死的负载均衡），响应头永远不来。
   * 时限从后面算的话，这种情况会**无限等下去** —— 而它恰恰是最该被判成超时的一种，
   * 因为它连一个能让上层解释的错误都没有。
   *
   * ── 为什么不用 `for await … break` ──
   *
   * 提前 `break` 会调用生成器的 `return()`，那会一路走到 `sseDataFrames` 的 finally，
   * 把**我们还打算继续读**的 body 取消掉。症状是「第一帧之后就再也没有下文」。
   */
  private async prime(
    messages: LlmMessage[],
    options: LlmRequestOptions | undefined,
    controller: AbortController,
    timing: { abortReason: InternalAbort },
    toolCalls: ToolCallAccumulator,
  ): Promise<{
    iterator: AsyncIterator<string>;
    model: string;
    first: string[];
  }> {
    const deadline = setTimeout(() => {
      // 调用方先一步取消的话，原因已经定了，别把它改写成「超时」。
      if (controller.signal.aborted) return;
      timing.abortReason = 'first-token';
      controller.abort();
    }, this.config.timeoutMs);

    try {
      const response = await this.post(messages, options, true, controller.signal);
      if (!response.body) {
        // 200 却没有 body：这不是「等会儿可能就好」的那类失败，重试也只是赌。
        throw new VendorError('厂商返回了流式响应头，却没有任何 body', false);
      }

      const iterator = sseDataFrames(response.body)[Symbol.asyncIterator]();
      let model = this.config.model;
      const first: string[] = [];

      for (;;) {
        const { value, done } = await iterator.next();
        if (done) break;

        const delta = parseVendorDelta(value);
        if (delta.error) {
          // 厂商明确回了错误（内容被拦、参数不认）—— 这是它的结论，不是抖动。
          throw new VendorError(`厂商在流里回了错误：${delta.error}`, false);
        }
        if (delta.model) model = delta.model;
        if (delta.toolCalls) toolCalls.add(delta.toolCalls);

        if (delta.text) {
          first.push(delta.text);
          break;
        }

        // 「第一帧有内容」的判据不能只看文本：模型决定调工具时，这一轮根本不会有文本。
        // 只等 text 的话，要一直读到流结束才返回 —— 首帧超时会把一次正常的工具调用
        // 误判成厂商挂了。所以工具碎片也算「它开口了」。
        if (delta.toolCalls) break;
      }

      return { iterator, model, first };
    } catch (error) {
      if (error instanceof VendorError) throw error;
      // 是我们自己掐的（首帧时限到了），不是厂商抖动 —— 重试只会让用户多等一轮。
      if (timing.abortReason !== null) throw error;
      // 剩下的都是「响应头到了、读首帧时连接断了」这类：还没交出去任何字节，
      // 重试是安全的。不在这里翻译的话，它会以一个裸的 undici 错误一路飘上去，
      // 外层既认不出它是网络问题，也就不会重试。
      throw new VendorError(`连不上模型厂商：${messageOf(error)}`, true);
    } finally {
      // ⚠️ 这个时限**只盖住「等第一个字」这一段**，不盖整条流：给整条流挂总时限的话，
      // 长回答会被腰斩 ——「首字迟迟不来」和「答得慢」是两种失败，只有前者该判成超时。
      // 但下半段也不是完全不管：两帧之间沉默太久同样会掐断，见 nextFrame()。
      clearTimeout(deadline);
    }
  }

  /**
   * 把剩下的帧变成事件。
   *
   * `first` 是首帧里已经取出来的那段 —— 它是在 `stream()` 里为了定 model 而提前拉出来的，
   * 不能丢，所以在这里补在最前面。少了这一步的症状是「答案少了开头几个字」，
   * 而流本身一切正常，很难往这儿想。
   *
   * 工具调用**攒到最后一次性发**：厂商发的是碎片，上层拿到完整的调用才能执行。
   * 这不是为了省事 —— 半截的 `{"co` 根本无法解析，也没有执行价值。
   */
  private async *streamEvents(
    iterator: AsyncIterator<string>,
    first: string[],
    toolCalls: ToolCallAccumulator,
    detach: () => void,
    callerAborted: () => boolean,
    controller: AbortController,
    timing: { abortReason: InternalAbort },
  ): AsyncGenerator<LlmStreamEvent> {
    try {
      for (const text of first) yield { type: 'text', text };

      for (;;) {
        const { value, done } = await this.nextFrame(
          iterator,
          controller,
          timing,
        );
        if (done) break;

        const delta = parseVendorDelta(value);
        if (delta.error) throw new Error(`厂商在流里回了错误：${delta.error}`);
        // 用量通常在这一帧里单独到（choices 为空）。它不参与「谁先说」的判定，
        // 所以只往上传，不影响下面的 break。
        if (delta.usage) yield { type: 'usage', usage: delta.usage };
        // 先收工具碎片，再把文本发出去 —— 两者撞在同一帧里时**都不能丢**。
        // 早先这里对带碎片的那一帧直接 `continue`，文本会被静默吞掉：
        // 症状是答案偶尔少一句话，而流本身一切正常。
        if (delta.toolCalls) toolCalls.add(delta.toolCalls);
        if (delta.text) yield { type: 'text', text: delta.text };
      }

      for (const call of toolCalls.finish()) yield { type: 'tool_call', call };
    } catch (error) {
      // 断开**发生在流中间**时走的是这条路（底层 body 被 abort，read 直接抛）。
      // 上层 `streamAnswer` 是靠「循环正常走完 + signal.aborted」判断用户走人的，
      // 这里不吞掉的话，那个判断永远不会被执行到，取而代之的是一个 error 事件。
      if (callerAborted()) {
        this.logger.log('调用方已取消，模型流提前结束');
        return;
      }
      if (timing.abortReason === 'stalled') {
        throw new VendorError(
          `模型流停住了：超过 ${this.config.timeoutMs} ms 没有新数据`,
          false,
        );
      }
      throw error;
    } finally {
      detach();
      // 消费方提前退出（客户端断开、或者上层主动不读了）时，这一句负责让
      // `sseDataFrames` 的 finally 跑到，那里会 cancel 掉底下的 body。
      await iterator.return?.(undefined).catch(() => undefined);
    }
  }

  /**
   * 读下一帧，并且给这次等待挂一个**闲置上限**。
   *
   * ── 为什么上半段有超时，不代表下半段也有 ──
   *
   * `prime()` 的时限只证明「厂商开口了」。一个半死的上游完全可以先吐一个字，
   * 然后永远沉默：连接没断、`read()` 不返回、心跳还在替这条连接续命。
   * 用户看到的是「生成中」一直转，服务端则一直占着一条连接和一个请求。
   *
   * ── 为什么是「帧与帧之间」而不是「整条流」 ──
   *
   * 整条流挂总时限会把答得慢的长回答腰斩。只要厂商还在发帧，多慢都该让它说完；
   * 真正该判死的是**沉默**。所以计时器在每一帧到达时重置。
   *
   * 触发时 abort 掉 controller，底下的 body 会以 abort 错误结束，`next()` 随之抛。
   */
  private async nextFrame(
    iterator: AsyncIterator<string>,
    controller: AbortController,
    timing: { abortReason: InternalAbort },
  ): Promise<IteratorResult<string>> {
    const timer = setTimeout(() => {
      // 调用方先一步取消的话，原因已经定了，别改写它。
      if (controller.signal.aborted) return;
      timing.abortReason = 'stalled';
      controller.abort();
    }, this.config.timeoutMs);

    try {
      return await iterator.next();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发请求，失败就按退避重试几次。
   *
   * 只给非流式用（流式那条的边界在 `stream()` 里 —— 它只能重试到第一个字为止）。
   * 能重试的前提是「重复发起没有副作用」：读一次模型确实没有，
   * 代价只是多花一次钱，而这个代价被 `maxAttempts` 封住了上限。
   */
  private async requestWithRetry<T>(
    send: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        const delay =
          attempt < this.config.maxAttempts
            ? this.retryDelayMs(error, attempt)
            : null;
        if (delay === null) throw error;
        this.logger.warn(
          `模型调用失败，${delay} ms 后重试（第 ${attempt} 次尝试）：${messageOf(error)}`,
        );
        await sleep(delay, signal);
      }
    }
  }

  /**
   * 这次失败等多久再试；`null` = 不该重试。
   *
   * 退避用「满抖动」（0 ~ 上限之间随机）而不是固定间隔：很多实例同时被限流时，
   * 固定间隔会让它们在同一毫秒一起回来，把对方再压垮一次。
   *
   * 厂商明确给了 `Retry-After` 就听它的 —— 它比我们更清楚什么时候有容量。
   * 但只在我们愿意等的范围内：超过 2 秒就放弃，让用户拿到一个明确的失败，
   * 而不是等着一个遥遥无期的「生成中」。
   */
  private retryDelayMs(error: unknown, attempt: number): number | null {
    if (!(error instanceof VendorError) || !error.retryable) return null;

    if (error.retryAfterMs !== undefined) {
      return error.retryAfterMs <= MAX_RETRY_DELAY_MS
        ? error.retryAfterMs
        : null;
    }

    const ceiling = Math.min(
      RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    return Math.round(Math.random() * ceiling);
  }

  /**
   * 发一次请求。两条路（complete / stream）只有 body 和 signal 不同，其余全一样。
   *
   * 非 2xx 一律抛。这里抛得越早越好：流式的调用方**已经**把 SSE 响应头发给浏览器了，
   * 此刻还能做的只是发一个 error 事件，而不是一个 502。
   */
  private async post(
    messages: LlmMessage[],
    options: LlmRequestOptions | undefined,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      // 只传协议认识的字段，别把项目内部的字段顺出去。
      messages: messages.map(serializeMessage),
      // 温度 0 是「尽量稳定」，不是「确定」。
      //
      // ⚠️ 这条注释原来写的是「同一份数据问同一个问题，答案稳定，评测的断言建立在这上面」。
      // 接上真厂商之后实测：同一请求连问三次，两次逐字相同、一次换了说法；
      // 有时结论一字不差，evidence 却多一个少一个字段。厂商侧的批处理、MoE 路由、
      // 浮点累加顺序都能让温度 0 仍然不可复现。
      //
      // 结论：**任何「两次调用必须逐字相同」的断言都站不住**。评测里跨调用的比较
      // 因此按 provider 分开（见 test/assistant-eval.e2e-spec.ts 开头）。
      temperature: options?.temperature ?? 0,
      max_tokens: this.config.maxTokens,
      stream,
    };
    // 只有流式需要这个：不流式时 usage 本来就在响应体里。
    // 打开后厂商会在 `[DONE]` 之前多发一帧，choices 为空、只带 usage ——
    // 那一帧**不是错误**，parseVendorDelta 认它。
    if (stream && this.config.streamUsage) {
      body.stream_options = { include_usage: true };
    }
    if (this.config.jsonMode) body.response_format = { type: 'json_object' };

    // 工具定义是**请求的一部分**，不是业务代码里的 if。模型看到的只有这三样：
    // 名字、描述、参数 schema —— 它按这个自己决定调不调、调哪个。
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      // 显式写 auto 而不是靠默认值：这个值说明的是**产品决定**
      // （查不查由模型定，不由我们预判），值得写出来。
      body.tool_choice = 'auto';
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        // 非流式挂总时限；流式只用调用方的 signal，首帧时限在 stream() 里单独管。
        signal: stream ? signal : this.timeoutSignal(this.config.timeoutMs, signal),
      });
    } catch (error) {
      throw this.describeFetchError(error);
    }

    if (!response.ok) await this.throwFromResponse(response);
    return response;
  }

  /**
   * 把「厂商不高兴了」翻译成一句能直接照着查的话。
   *
   * ⚠️ 这里**只读响应**，不回显请求头 —— API key 在请求头里，所以它不可能出现在
   * 这条消息里。这不是碰巧：日志、异常、评测报告都可能被贴到别处去，
   * 「密钥绝不会被我们自己打出来」这件事必须是结构上成立的，不能靠小心。
   */
  private async throwFromResponse(response: Response): Promise<never> {
    const raw = await response.text().catch(() => '');
    const hint =
      response.status === 401 || response.status === 403
        ? '（检查 LLM_API_KEY）'
        : response.status === 402
          ? '（厂商账户余额不足）'
          : response.status === 429
            ? '（厂商限流或额度用尽）'
            : '';
    throw new VendorError(
      `模型厂商返回 ${response.status}${hint}：${truncate(raw)}`,
      RETRYABLE_STATUS.has(response.status),
      retryAfterMs(response.headers.get('retry-after')),
    );
  }

  /**
   * 三种失败，重试价值完全不同。
   *
   * `TimeoutError` 是我们的时限到了 —— 已经等满一整个 `timeoutMs`，再等一轮
   * 只是把用户的等待翻倍，所以它**不重试**。`AbortError` 是调用方取消，更不该重试。
   * 剩下的（连接被重置、DNS 抖动、对端滚动重启）通常是瞬时的，值得再试一次 ——
   * 而且这类失败来得很快，重试的代价是毫秒级。
   */
  private describeFetchError(error: unknown): VendorError {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new VendorError(
        `调用模型超时（${this.config.timeoutMs} ms）`,
        false,
      );
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new VendorError('模型调用被取消', false);
    }
    return new VendorError(
      `连不上模型厂商：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }

  /**
   * 最短的那个截止时间生效。
   *
   * `AbortSignal.timeout` 需要 Node 20.3+（这个项目锁的是 20.20.2，本机和镜像一致）；
   * `AbortSignal.any` 同理。用它们而不是自己写 `setTimeout` + `clearTimeout`，
   * 是因为手写的那份在**正常完成时**会留一个待触发的定时器 —— 测试进程会因此不退出。
   */
  private timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return outer ? AbortSignal.any([outer, timeout]) : timeout;
  }
}

async function* emptyEvents(): AsyncGenerator<LlmStreamEvent> {
  // 什么都不吐。调用方（`AssistantService.streamAnswer`）会看到流立刻就结束了。
}

/**
 * 把内部消息翻译成厂商的线格式。
 *
 * 三处不能省：
 *   · assistant 带工具调用那轮，必须把 `tool_calls` **原样回传** —— 厂商要靠它
 *     把下一轮的 `role:"tool"` 结果对上号，缺了这一段，模型会以为工具调用凭空消失了。
 *   · `role:"tool"` 必须带 `tool_call_id`，它是**唯一**的配对依据（不是函数名）。
 *   · 不带工具调用的普通消息只留 role/content，项目内部的字段一个都不外送。
 */
function serializeMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: message.content,
    };
  }

  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  return { role: message.role, content: message.content };
}

/**
 * 把流里按 `index` 到达的工具调用碎片拼成完整的调用。
 *
 * 碎片长这样（实测 DeepSeek）：
 *   帧1  index:0, id:"call_x", name:"get_expense_summary", arguments:""
 *   帧2  index:0,                                          arguments:"{}"
 * 参数被切成任意多段是常态，所以必须**按 index 累加**，不能遇到一片就发一次。
 */
class ToolCallAccumulator {
  private readonly calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  add(deltas: VendorToolCallDelta[]): void {
    for (const delta of deltas) {
      const current = this.calls.get(delta.index) ?? {
        id: '',
        name: '',
        arguments: '',
      };

      if (delta.id) current.id = delta.id;
      if (delta.name) current.name = delta.name;
      if (delta.arguments) current.arguments += delta.arguments;

      this.calls.set(delta.index, current);
    }
  }

  finish(): LlmToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call], index) => ({
        // 兼容实现可能不给 id —— 补一个稳定的，不然下一轮回传时配不上对。
        id: call.id || `call_${index}`,
        name: call.name,
        // 参数可能一片都没来（无参工具）。空串不是合法 JSON，按 `{}` 处理。
        arguments: call.arguments || '{}',
      }))
      .filter((call) => call.name !== '');
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 截断是为了不让日志被一整段 HTML 错误页淹没 —— 但保留开头，那里才有状态码和原因。 */
function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字）`;
}

/**
 * 读 `Retry-After`。
 *
 * 只认「秒数」那种写法（限流响应里最常见）。HTTP 日期那种能表达的时间尺度
 * 通常远超我们愿意等的 2 秒，解析它没有收益 —— 返回 undefined，退回自己的退避。
 */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * 可取消的等待。
 *
 * 取消时**立刻醒来**而不是 reject：重试循环下一圈会看到 signal 已经 aborted，
 * 于是走正常的「调用方取消」收尾 —— 错误路径只有一处，不在退避里再分一条叉。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', wake);
      resolve();
    };

    timer = setTimeout(wake, ms);
    signal?.addEventListener('abort', wake, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
