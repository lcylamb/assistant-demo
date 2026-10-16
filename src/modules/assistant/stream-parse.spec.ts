import { parseAnswer } from './parse-answer.js';
import { partialConclusion } from './stream-parse.js';

/**
 * 一份**带真转义**的模型输出。
 *
 * 用字符串字面量而不是 JSON.stringify 来造：后者不会把 😀 写成 `\uD83D\uDE00`，
 * 而代理对恰好是这个解析器里唯一「宁可等也不能吐半个」的地方，必须覆盖到。
 */
const SAMPLE =
  '{"conclusion":"这张单被驳回\\n原因：招待费「超出」预算\\t标的是 \\"市场部\\" \\uD83D\\uDE00 结尾","evidence":["status"],"insufficient":false}';

describe('partialConclusion', () => {
  describe('能解出来的输入', () => {
    const cases: Array<[name: string, text: string, expected: string]> = [
      [
        '完整的 JSON',
        '{"conclusion":"已通过","evidence":[],"insufficient":false}',
        '已通过',
      ],
      [
        'conclusion 不是第一个键',
        '{"evidence":[],"conclusion":"已通过","insufficient":false}',
        '已通过',
      ],
      [
        '冒号前后有空白',
        '{"conclusion" :  "已通过" ,"evidence":[]}',
        '已通过',
      ],
      [
        '外层套了 ```json 代码块',
        '```json\n{"conclusion":"已通过","evidence":[]}\n```',
        '已通过',
      ],
      ['转义引号', '{"conclusion":"他说 \\"好\\"","x":1}', '他说 "好"'],
      ['转义反斜杠', '{"conclusion":"C:\\\\盘","x":1}', 'C:\\盘'],
      ['转义换行与制表符', '{"conclusion":"第一行\\n第二行\\t缩进"}', '第一行\n第二行\t缩进'],
      ['正斜杠转义（JSON 允许）', '{"conclusion":"a\\/b"}', 'a/b'],
      ['代理对拼成一个字符', '{"conclusion":"\\uD83D\\uDE00"}', '😀'],
      ['BMP 码位', '{"conclusion":"\\u4e2d\\u6587"}', '中文'],
      ['字符串未闭合，先吐已解出的', '{"conclusion":"还没说完', '还没说完'],
      ['反斜杠在最后，等下一个字符', '{"conclusion":"abc\\', 'abc'],
      ['\\u 只到了一半', '{"conclusion":"abc\\u12', 'abc'],
      ['只有高位代理，先等低位', '{"conclusion":"abc\\uD83D', 'abc'],
      [
        '已能证明是孤立代理，照实吐出后继续解后面的字符',
        '{"conclusion":"abc\\uD83Dx',
        'abc\ud83dx',
      ],
    ];

    it.each(cases)('%s', (_name, text, expected) => {
      expect(partialConclusion(text)).toBe(expected);
    });
  });

  describe('还不到该说话的时候', () => {
    const silent: Array<[name: string, text: string]> = [
      ['空字符串', ''],
      ['模型还在写寒暄，没有 JSON', '好的，让我看看这张单子……'],
      ['键名只写了一半', '{"conclu'],
      ['键名到齐但冒号还没来', '{"conclusion"'],
      ['冒号到齐但引号还没来', '{"conclusion": '],
      ['冒号后跟的不是字符串', '{"conclusion": null}'],
      ['别的键里出现了同名词', '{"note":"conclusion"'],
    ];

    it.each(silent)('%s → 返回空串', (_name, text) => {
      expect(partialConclusion(text)).toBe('');
    });
  });

  it('❌ 已知不设防：别的字符串值里出现 "conclusion": "x" 时会误判', () => {
    // 这条断言记录的是**已知缺陷**，不是期望行为。
    // 兜底在流结束后的 parseAnswer —— 它会以顶层那个 conclusion 为准，
    // 页面上增量吐的字会被最终结果覆盖。
    const text = '{"note":"conclusion":"假的","conclusion":"真的"}';
    expect(partialConclusion(text)).toBe('假的');
  });
});

describe('增量拼接的正确性', () => {
  /** 模拟 service 里的循环：每次拿到新的一块就重扫整个 buffer，只取新增的那段。 */
  function simulate(pieces: string[]): string {
    let buffer = '';
    let emitted = '';

    for (const piece of pieces) {
      buffer += piece;
      const partial = partialConclusion(buffer);

      // 前缀性是整个增量方案的地基：没有它，前端就会出现「已经显示过的字被改写」。
      expect(partial.startsWith(emitted), `前缀性在 ${JSON.stringify(piece)} 处被破坏`).toBe(
        true,
      );

      emitted = partial;
    }

    return emitted;
  }

  const parsed = parseAnswer(SAMPLE);

  it('样例本身是合法的，结论里确实含换行和代理对', () => {
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.conclusion).toContain('\n');
      expect(parsed.value.conclusion).toContain('😀');
      expect(parsed.value.conclusion).toContain('"');
    }
  });

  it('一个字一个字地喂，拼出来 == 最终校验过的结论', () => {
    // 这是最强的那个断言：增量吐出去的东西，必须和最终 parseAnswer 认可的**逐字相同**。
    // 否则页面上「生成中」显示的内容，和变成「已确认」之后的内容就会不一致。
    //
    // 这里刻意用展开运算符（按**码点**拆，代理对不会被劈开），
    // 和下面那条按码元拆的正好构成一对 —— 两种切法都要过。
    // oxlint-disable-next-line typescript/no-misused-spread -- 按码点拆正是本用例的目的
    expect(parsed.ok && simulate([...SAMPLE])).toBe(parsed.ok && parsed.value.conclusion);
  });

  it('按 UTF-16 码元切（会把代理对劈成两半），结果一样', () => {
    expect(parsed.ok && simulate(SAMPLE.split(''))).toBe(
      parsed.ok && parsed.value.conclusion,
    );
  });

  it('在**任意**下标处切成两块，结果都一样', () => {
    // 断点可能落在任何地方 —— 转义序列中间、`\u` 的四个十六进制位中间、
    // 代理对的两半之间。这条把「任意断点」这件事一次性证完。
    for (let cut = 0; cut <= SAMPLE.length; cut += 1) {
      const pieces = [SAMPLE.slice(0, cut), SAMPLE.slice(cut)];
      expect(simulate(pieces), `在下标 ${cut} 处切开后结果不同`).toBe(
        parsed.ok && parsed.value.conclusion,
      );
    }
  });
});
