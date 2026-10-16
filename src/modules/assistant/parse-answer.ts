import type { AskResult } from './ask.types.js';

export type ParseOutcome =
  | { ok: true; value: AskResult }
  | { ok: false; reason: string };

/**
 * 把模型返回的**原始文本**解析成 AskResult。
 *
 * 纯函数，不碰数据库也不碰网络 —— 这样它才能被穷举地测（见 parse-answer.spec.ts），
 * 而增量解析器也要复用同一份判断标准。
 *
 * 返回判别联合而不是抛异常：调用方需要区分「模型答得不对」和「数据库出错了」，
 * 这两种失败对用户的含义完全不同，用异常控制流会把它们混成一种。
 */
export function parseAnswer(raw: string): ParseOutcome {
  const candidate = extractJsonObject(raw);
  if (candidate === null) {
    return { ok: false, reason: '返回内容里找不到 JSON 对象' };
  }

  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // candidate 一定以 `{` 开头、以 `}` 结尾，所以这里必然是个对象，
  // 不需要再判一次类型 —— 真正的形状校验是下面三条字段检查。
  const record = data as Record<string, unknown>;

  if (typeof record.conclusion !== 'string' || record.conclusion.trim() === '') {
    return { ok: false, reason: 'conclusion 缺失，或不是非空字符串' };
  }

  if (
    !Array.isArray(record.evidence) ||
    record.evidence.some((item) => typeof item !== 'string')
  ) {
    return { ok: false, reason: 'evidence 缺失，或不是字符串数组' };
  }

  if (typeof record.insufficient !== 'boolean') {
    return { ok: false, reason: 'insufficient 缺失，或不是布尔值' };
  }

  return {
    ok: true,
    value: {
      conclusion: record.conclusion.trim(),
      // 去空白 + 去重：模型经常把同一个字段写两遍，或者补个空格。
      // 这属于噪音不属于错误，顺手清掉比让上层去处理更省事。
      evidence: [
        ...new Set(
          (record.evidence as string[]).map((item) => item.trim()).filter(Boolean),
        ),
      ],
      insufficient: record.insufficient,
    },
  };
}

/**
 * 从一段可能不干净的文本里，取出 JSON 对象。
 *
 * 取「第一个 `{` 到最后一个 `}`」就够了，因为真实模型的不干净只有两种：
 * 前面写一句「好的，这是答案：」，或者外面套一层 ```json 代码块 —— 这两种
 * 这个办法都能吃下去，不用为它们各写一个正则。
 *
 * ⚠️ 它当然不严谨：模型要是在 JSON 前后另写了一段带花括号的话，就会取错。
 * 兜底不是让它变严谨，而是后面的结构校验 —— 取错了会解析失败或字段对不上，
 * 变成一次明确的报错，而不是一个悄悄错掉的答案。
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}
