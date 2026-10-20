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

/** 从一帧里解出来的东西。三个字段都可选：大部分帧只有其中一样。 */
export interface VendorDelta {
  /** 厂商在这一帧里报的模型名。通常每帧都带，所以我们不必猜。 */
  model?: string;
  /** 增量文本。空串不收 —— 厂商会发只有 role 没有 content 的首帧。 */
  text?: string;
  /** 厂商在流中间回的错误（额度用尽、模型下线）。它可能出现在 HTTP 200 的流里。 */
  error?: string;
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

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.delta)) {
    const content = choice.delta.content;
    if (typeof content === 'string' && content !== '') out.text = content;
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
