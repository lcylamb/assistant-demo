import { parseAnswer } from './parse-answer.js';

const VALID = '{"conclusion":"已通过","evidence":["status"],"insufficient":false}';

describe('parseAnswer', () => {
  describe('能正常解析的输入', () => {
    const okCases: Array<[name: string, raw: string]> = [
      ['干净的 JSON', VALID],
      ['包在 ```json 代码块里', `\`\`\`json\n${VALID}\n\`\`\``],
      ['包在没有语言标注的代码块里', `\`\`\`\n${VALID}\n\`\`\``],
      ['前面带一句寒暄', `好的，这是答案：\n${VALID}`],
      ['后面带一句解释', `${VALID}\n希望有帮助。`],
      ['前后都有', `好的：\n\`\`\`json\n${VALID}\n\`\`\`\n需要我继续吗？`],
      [
        '多了一个我们不认识的键',
        '{"conclusion":"已通过","evidence":["status"],"insufficient":false,"confidence":0.9}',
      ],
      [
        '模型把单元素数组当成顶层',
        `[${VALID}]`,
      ],
    ];

    it.each(okCases)('%s', (_name, raw) => {
      const outcome = parseAnswer(raw);
      expect(outcome.ok).toBe(true);
    });
  });

  describe('会失败的输入', () => {
    const failCases: Array<[name: string, raw: string]> = [
      ['压根不是 JSON', '抱歉，我无法回答这个问题。'],
      ['空字符串', ''],
      ['只有花括号', '{}'],
      ['JSON 被截断', '{"conclusion":"已通'],
      ['多元素数组（首尾配对后不是合法 JSON）', '[{"a":1},{"b":2}]'],
      ['conclusion 缺失', '{"evidence":[],"insufficient":false}'],
      ['conclusion 是空串', '{"conclusion":"  ","evidence":[],"insufficient":false}'],
      ['conclusion 不是字符串', '{"conclusion":123,"evidence":[],"insufficient":false}'],
      ['evidence 缺失', '{"conclusion":"x","insufficient":false}'],
      ['evidence 不是数组', '{"conclusion":"x","evidence":"status","insufficient":false}'],
      [
        'evidence 里混了非字符串',
        '{"conclusion":"x","evidence":["status",1],"insufficient":false}',
      ],
      ['insufficient 缺失', '{"conclusion":"x","evidence":[]}'],
      // 这条最值得单独测：模型很爱把布尔值写成字符串，而 "false" 在 JS 里是真值，
      // 放过它会让「信息不足」的标记完全失效 —— 明明缺数据，接口却报 insufficient=false。
      [
        'insufficient 是字符串 "false"',
        '{"conclusion":"x","evidence":[],"insufficient":"false"}',
      ],
    ];

    it.each(failCases)('%s', (_name, raw) => {
      const outcome = parseAnswer(raw);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBeTruthy();
    });
  });

  describe('清理', () => {
    it('去掉 conclusion 前后的空白', () => {
      const outcome = parseAnswer(
        '{"conclusion":"  已通过  ","evidence":[],"insufficient":false}',
      );
      expect(outcome.ok && outcome.value.conclusion).toBe('已通过');
    });

    it('evidence 去重、去空白、丢掉空串', () => {
      const outcome = parseAnswer(
        '{"conclusion":"x","evidence":["status"," status ",""," amount "],"insufficient":false}',
      );
      expect(outcome.ok && outcome.value.evidence).toEqual(['status', 'amount']);
    });

    it('保留 insufficient 的布尔假值，不会被当成「没给」', () => {
      const outcome = parseAnswer(VALID);
      expect(outcome.ok && outcome.value.insufficient).toBe(false);
    });
  });
});
