/**
 * 裸打流式端点，打印每一块的到达时间。
 *
 *   node scripts/ask-stream-probe.mjs            # 默认问 BX-2026-0006 的明细
 *   node scripts/ask-stream-probe.mjs BX-2026-0003 "为什么被驳回？"
 *
 * 存在的意义：让「这是真流式」**可复现**，而不是一句自述。
 * 「首字延迟 ≪ 总耗时」这个差距，只有真的一块一块发才有 ——
 * 攒完再吐的实现里，两者会几乎相等。
 *
 * ⚠️ 用假模型时这个差距是被两个常量（CHUNK_SIZE / CHUNK_DELAY_MS）**造出来**的，
 * 不是模型的速度。它能证明管道是流式的，不能证明模型有多快。
 */
const [, , code = 'BX-2026-0006', question = '这笔钱都花在哪些项目上？'] = process.argv;

const url = `${process.env.BASE_URL ?? 'http://localhost:3100'}/assistant/askStream`;

const started = performance.now();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, question }),
});

console.log(`${code}　${question}`);
console.log(`HTTP ${response.status}　${response.headers.get('content-type')}\n`);

if (!response.ok) {
  console.log(await response.text());
  process.exit(1);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let chars = 0;
let firstAt = null;
let pings = 0;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });

  // 和 index.html 里那段是同一套规则：按空行切帧，不完整的留在 buffer 里。
  let boundary;
  while ((boundary = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);

    // 注释帧（`: ping`）是心跳，没有 data。按规范忽略，只计数 ——
    // 工具轮里几秒钟没字时，就是它在替连接续命（见 assistant.controller.ts）。
    if (!frame.includes('data:')) {
      pings += 1;
      continue;
    }

    const name = /event: (\w+)/.exec(frame)?.[1];
    const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
    const at = Math.round(performance.now() - started);

    if (name === 'delta') {
      if (firstAt === null) firstAt = at;
      chars += data.text.length;
      console.log(`+${String(at).padStart(4)} ms  ${JSON.stringify(data.text)}`);
    } else {
      console.log(`+${String(at).padStart(4)} ms  [${name}] ${JSON.stringify(data)}`);
    }
  }
}

console.log(
  `\n首字延迟 ${firstAt} ms ／ 总耗时 ${Math.round(performance.now() - started)} ms ／ 增量共 ${chars} 字 ／ 心跳 ${pings} 次`,
);
