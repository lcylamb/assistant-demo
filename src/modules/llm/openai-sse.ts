/**
 * OpenAI 兼容的流式响应拆帧。
 *
 * 这个文件是**纯的**：只依赖 Web 标准的 `ReadableStream`，不 import 任何项目里的东西，
 * 也不知道 `LlmProvider` 是什么。理由是它要能被单测直接喂字节 —— 断帧这件事的全部难点
 * 都在「网络给的是字节，不是消息」上，而字节怎么切只有真拿字节来试才发现得了。
 *
 * ⚠️ 和 `assistant.controller.ts` 里写帧、`test/support/sse.ts` 里读帧是**三件不同的事**，
 * 别混：那两个说的是**我们**对外发的 SSE（`event:` + `data:`），
 * 这里说的是**厂商**发给我们看的 SSE（只有 `data:`，一帧一个 JSON 片段）。
 * 形状像不等于同一套规则 —— 厂商那套必须容忍更多花样，因为它不由我们说了算。
 */

/** 流式帧里的一段工具调用。同一次调用会分很多片到达，靠 `index` 归并。 */
export interface VendorToolCallDelta {
  index: number;
  /** 只有第一片带 id。 */
  id?: string;
  /** 只有第一片带 name。 */
  name?: string;
  /** 参数 JSON 被切成许多片，逐片拼接才是完整的。 */
  arguments?: string;
}

/**
 * 厂商报的用量。**两个数字必须齐全才算数** —— 只报一个的实现，我们宁可当它没报，
 * 也不要拿半份数据去算成本（那会让成本看起来比实际低，而且没有任何提示）。
 */
export interface VendorUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 从一帧里解出来的东西。字段都可选：大部分帧只有其中一样。 */
export interface VendorDelta {
  /** 厂商在这一帧里报的模型名。通常每帧都带，所以我们不必猜。 */
  model?: string;
  /** 增量文本。空串不收 —— 厂商会发只有 role 没有 content 的首帧。 */
  text?: string;
  /** 厂商在流中间回的错误（额度用尽、模型下线）。它可能出现在 HTTP 200 的流里。 */
  error?: string;
  /** 这一帧里工具调用的碎片。 */
  toolCalls?: VendorToolCallDelta[];
  /** 这一帧里的用量。通常在流末尾单独一帧（choices 为空）里到。 */
  usage?: VendorUsage;
}

/**
 * 把响应体拆成一帧一帧的 `data:` 载荷。
 *
 * 三个必须容忍的花样，都是真实厂商会发的：
 *   1. **一帧可能不带空行结尾**（最后一片），所以循环结束后还要再收一次尾。
 *   2. **`data:` 可以重复多行**，按 SSE 规范是换行拼接 —— 不能只取第一行。
 *   3. **注释行（`:` 开头）是心跳**，用来保活的，不是数据。漏判的话它会变成一次 JSON 解析失败。
 *
 * `[DONE]` 在这里就被吃掉，不往上传：它是**协议层的结束标记**，不是内容。
 * 上面那层拿到的每个载荷都应该是能解析的 JSON，这个不变量值得守住。
 */
export async function* sseDataFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // ⚠️ `{ stream: true }` 不能省。少了它，一个 UTF-8 汉字正好跨在两次 read 中间时，
      // 两次都会解出替换字符（U+FFFD）—— 症状是答案里偶尔冒出一个「�」。
      // 这和 public/index.html 里那段客户端代码是同一个坑。
      //
      // 顺手把 CRLF 归一成 LF：SSE 规范允许 CRLF 结尾，而 JSON 字符串里的裸 CR
      // 本来就是非法的（必须写成 \\r），所以这一步不会改坏任何载荷。
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const payload = dataPayload(frame);
        if (payload !== null) yield payload;
      }
    }

    // 收尾：把解码器里剩下的字节倒出来，再处理最后那个没有空行结尾的帧。
    buffer += decoder.decode();
    const tail = dataPayload(buffer);
    if (tail !== null) yield tail;
  } finally {
    // 消费方提前走人时（客户端断开），这里负责把底下那条连接也放掉。
    // 不这么做的话，用户已经关掉页面了，厂商那边还会把整段答案算完 —— 那是真金白银。
    //
    // 正常读完时这行是空操作（流已经关了），所以不需要判断「是不是提前退出」。
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * 取一帧里的数据载荷。没有数据行就返回 null（纯注释帧、纯 `event:` 帧都会走到这里）。
 *
 * `line.slice(5)` 之后还要吃掉一个前导空格：规范写的是 `data: payload`，
 * 那个空格是分隔符不属于内容。厂商如果发 `data:{"...` 也不能少一个字。
 */
function dataPayload(frame: string): string | null {
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }

  if (dataLines.length === 0) return null;

  const payload = dataLines.join('\n');
  return payload.trim() === '[DONE]' ? null : payload;
}

/**
 * 解一帧载荷。**解不出来不算错误** —— 返回空对象，调用方当这一帧没发生。
 *
 * 为什么这么宽：厂商偶尔会插一帧我们不认识的形状（新加的字段、保活用的 `{}`），
 * 为此把整条流判成失败，等于让一次兼容性小插曲变成用户看到的错误页。
 * 真正该报的错是 `error` 字段，那个我们认得。
 *
 * `choices` 为空数组是**合法且常见**的：开了用量统计后，最后一帧只带 `usage`、
 * 不带任何 choice。当成错误的话，每次调用都会在结尾炸一下。
 */
export function parseVendorDelta(payload: string): VendorDelta {
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return {};
  }

  if (!isRecord(body)) return {};

  const out: VendorDelta = {};

  if (typeof body.model === 'string' && body.model !== '') out.model = body.model;

  if (isRecord(body.error) && typeof body.error.message === 'string') {
    out.error = body.error.message;
  }

  // usage 在**顶层**，不在 choices[0].delta 里 —— 而且那一帧的 choices 常常是空数组。
  // 这也是 parseVendorDelta 下面那个「choices 为空是合法」的注释存在的理由。
  const usage = usageOf(body.usage);
  if (usage) out.usage = usage;

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.delta)) {
    const content = choice.delta.content;
    if (typeof content === 'string' && content !== '') out.text = content;

    const toolCalls = toolCallDeltas(choice.delta.tool_calls);
    if (toolCalls.length > 0) out.toolCalls = toolCalls;
  }

  return out;
}

/**
 * 非流式响应里的 `choices[0].message`。
 *
 * 和 `parseVendorDelta` 分开，是因为两块协议的形状本就不同：流式的工具调用是碎片，
 * 非流式的是成品。用一个函数兼容两种形状，会把「碎片要拼」这件事藏进分支里。
 */
export interface VendorMessage {
  model?: string;
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: VendorUsage;
}

export function parseVendorMessage(body: unknown): VendorMessage {
  const out: VendorMessage = { text: '', toolCalls: [] };
  if (!isRecord(body)) return out;

  if (typeof body.model === 'string' && body.model !== '') out.model = body.model;

  const usage = usageOf(body.usage);
  if (usage) out.usage = usage;

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!isRecord(choice)) return out;

  const message = choice.message;
  if (!isRecord(message)) return out;

  if (typeof message.content === 'string') out.text = message.content;

  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isRecord(raw)) continue;
      const fn = raw.function;
      if (!isRecord(fn)) continue;
      if (typeof fn.name !== 'string' || fn.name === '') continue;
      out.toolCalls.push({
        // 有的兼容实现不给 id。补一个确定性的，免得上层拿到空串当主键用。
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `call_${out.toolCalls.length}`,
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
      });
    }
  }

  return out;
}

/**
 * 解一帧里的工具调用碎片。
 *
 * `index` 缺失就按 0 处理：协议说必须有，但兼容实现给不给不由我们说了算。
 * 没有 index 又没有 name/arguments 的碎片直接丢（那是空对象）。
 */
function toolCallDeltas(raw: unknown): VendorToolCallDelta[] {
  if (!Array.isArray(raw)) return [];

  const out: VendorToolCallDelta[] = [];
  raw.forEach((item, position) => {
    if (!isRecord(item)) return;
    const fn = isRecord(item.function) ? item.function : {};

    const index = typeof item.index === 'number' ? item.index : position;
    const delta: VendorToolCallDelta = { index };

    if (typeof item.id === 'string' && item.id !== '') delta.id = item.id;
    if (typeof fn.name === 'string' && fn.name !== '') delta.name = fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments !== '') {
      delta.arguments = fn.arguments;
    }

    if (delta.id === undefined && delta.name === undefined && delta.arguments === undefined) {
      return;
    }
    out.push(delta);
  });

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 解厂商的 `usage`。
 *
 * 数字必须是非负有限数、且**两个都在**。宁可返回 undefined 让上层记「这一轮没报」，
 * 也不要把缺的那一半当成 0 —— 成本核算里，一个偏低的数字比一个已知的「不知道」危险得多：
 * 前者看起来是结论，后者会逼人去查。
 */
function usageOf(raw: unknown): VendorUsage | undefined {
  if (!isRecord(raw)) return undefined;

  const prompt = raw.prompt_tokens;
  const completion = raw.completion_tokens;
  if (!isCount(prompt) || !isCount(completion)) return undefined;

  return { promptTokens: prompt, completionTokens: completion };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
