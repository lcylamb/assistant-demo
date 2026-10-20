import { parseVendorDelta, sseDataFrames } from './openai-sse.js';

/**
 * 拆帧和解析的单测。
 *
 * 这个文件能存在的全部前提是 `openai-sse.ts` 是**纯的** —— 它只认字节流，
 * 不认 HTTP、不认 provider。所以这里能直接拿造出来的字节喂它，
 * 而「网络到底怎么切这段字节」这件事才可能被穷举。
 *
 * 用真服务器做不到这一点：TCP 把字节怎么分给 `read()` 是不确定的，
 * 写一百次不一定有一次正好切在汉字中间。
 */

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const MODEL = 'test-model';

/** 一个正常的文本增量帧。 */
const delta = (content: string) =>
  frame({ model: MODEL, choices: [{ index: 0, delta: { content } }] });

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of sseDataFrames(body)) out.push(payload);
  return out;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('sseDataFrames', () => {
  describe('各种形状的帧', () => {
    const cases: Array<[name: string, raw: string, expected: string[]]> = [
      [
        '普通的两帧',
        delta('你好') + delta('世界'),
        [
          JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: '你好' } }] }),
          JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: '世界' } }] }),
        ],
      ],
      [
        '`[DONE]` 是协议层的结束标记，不往上传',
        delta('好') + 'data: [DONE]\n\n',
        [JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: '好' } }] })],
      ],
      [
        '最后一片没有空行结尾也要收',
        delta('尾巴'),
        [JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: '尾巴' } }] })],
      ],
      [
        'CRLF 结尾（规范允许）',
        `data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n`,
        ['{"a":1}', '{"b":2}'],
      ],
      [
        '冒号开头是心跳注释，不是数据',
        ': keep-alive\n\n' + delta('好'),
        [JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: '好' } }] })],
      ],
      [
        'event: 行跳过，data 照收',
        'event: message\ndata: {"a":1}\n\n',
        ['{"a":1}'],
      ],
      [
        '多行 data: 按规范用换行拼起来',
        'data: {"a":\ndata: 1}\n\n',
        ['{"a":\n1}'],
      ],
      [
        '`data:` 后面没有空格也得认',
        'data:{"a":1}\n\n',
        ['{"a":1}'],
      ],
      [
        '完全没有数据行的帧被丢掉',
        'event: ping\n\n' + delta('好'),
        [JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: '好' } }] })],
      ],
    ];

    it.each(cases)('%s', async (_name, raw, expected) => {
      expect(await collect(streamOf([bytes(raw)]))).toEqual(expected);
    });
  });

  describe('断点', () => {
    /**
     * **这份文件里最值钱的一条。**
     *
     * 在**每一个**字节下标处把流切开，断言结果和整段一次喂进去完全一样。
     * 它锁住的正是「网络给的是字节，不是消息」这件事 ——
     * 帧边界、`data:` 前缀、JSON、UTF-8 汉字，全都可能被切在中间，
     * 而每一种切法都该得到同一个答案。
     *
     * 不这么测的话，只能碰运气：手写几个分割点，恰好都没切在汉字中间，
     * 于是解码器的 `{stream:true}` 漏了也测不出来。
     */
    const SAMPLE =
      delta('这张单被驳回\n原因：招待费「超出」预算 😀') +
      ': keep-alive\n\n' +
      delta('　标的是 "市场部"') +
      frame({ model: MODEL, choices: [] }) +
      'data: [DONE]\n\n';

    it('在每一个下标切开，结果都和整段一致', async () => {
      const all = bytes(SAMPLE);
      const whole = await collect(streamOf([all]));
      expect(whole.length).toBeGreaterThan(2);

      for (let index = 0; index <= all.length; index += 1) {
        const got = await collect(
          streamOf([all.subarray(0, index), all.subarray(index)]),
        );
        expect(got, `在下标 ${index} 切开时结果不一致`).toEqual(whole);
      }
    });

    it('一次一个字节地喂，也一样', async () => {
      const all = bytes(SAMPLE);
      const singles = Array.from(all, (_, index) => all.subarray(index, index + 1));
      expect(await collect(streamOf(singles))).toEqual(await collect(streamOf([all])));
    });
  });
});

describe('parseVendorDelta', () => {
  it('取模型名和增量文本', () => {
    expect(
      parseVendorDelta(JSON.stringify({ model: MODEL, choices: [{ delta: { content: '你' } }] })),
    ).toEqual({ model: MODEL, text: '你' });
  });

  it('首帧只有 role 没有 content —— 不能吐一个空串出去', () => {
    expect(
      parseVendorDelta(JSON.stringify({ model: MODEL, choices: [{ delta: { role: 'assistant' } }] })),
    ).toEqual({ model: MODEL });
  });

  it('content 是空串时也不收', () => {
    expect(
      parseVendorDelta(JSON.stringify({ choices: [{ delta: { content: '' } }] })),
    ).toEqual({});
  });

  it('用量帧的 choices 是空数组 —— 合法，不是错误', () => {
    expect(
      parseVendorDelta(JSON.stringify({ model: MODEL, choices: [], usage: { total_tokens: 42 } })),
    ).toEqual({ model: MODEL });
  });

  it('流中间的错误帧要认得出来', () => {
    expect(parseVendorDelta(JSON.stringify({ error: { message: '额度用尽' } }))).toEqual({
      error: '额度用尽',
    });
  });

  describe('不认识的东西一律当这一帧没发生，不抛', () => {
    const junk: Array<[name: string, payload: string]> = [
      ['不是 JSON', 'oops'],
      ['是 JSON 但不是对象', '42'],
      ['是对象但没有 choices', '{"id":"x"}'],
      ['choices 不是数组', '{"choices":"nope"}'],
      ['delta 是 null', '{"choices":[{"delta":null}]}'],
      ['content 是对象', '{"choices":[{"delta":{"content":{"a":1}}}]}'],
      ['error 里没有 message', '{"error":{"code":500}}'],
    ];

    it.each(junk)('%s', (_name, payload) => {
      expect(parseVendorDelta(payload)).toEqual({});
    });
  });
});
