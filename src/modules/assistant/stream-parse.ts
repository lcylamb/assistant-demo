/**
 * 增量解析：从**一段可能还不完整**的 JSON 文本里，抠出 `conclusion` 已经解出来的那部分。
 *
 * 为什么需要它：流式返回的是模型原始文本的 token。要让字一个个出现在页面上，
 * 就必须在 `{"conclusion": "这张单…` 这种还没闭合的状态下，把它已经说出来的部分认出来。
 *
 * ## 关键设计决定：不做状态机，每次从头重扫
 *
 * 用状态机的话，得在状态里保存「我正停在哪个转义序列的中间」—— 那恰恰是最容易写错、
 * 也最难测的地方。重扫是**幂等**的：同一个文本永远得到同一个结果，没有状态可以出错。
 *
 * 代价是整体 O(n²)。但 n 是一句话的长度（几十到几百字符），为它引入状态机不划算。
 *
 * ## 诚实边界
 *
 * 它**不保证** `conclusion` 是顶层键，也**不防**「别的字符串值里恰好出现 `"conclusion"`」。
 * 这两件事的兜底是**流结束后那一次 `parseAnswer`**：增量阶段吐出去的字随时可能被
 * 最终结果推翻 —— 这正是「最终结果必须走同一套校验」的理由，也是页面上那行
 * 「生成中」必须变成「已确认」才作数的原因。
 */

const KEY = '"conclusion"';
const HEX4 = /^[0-9a-fA-F]{4}$/;

export function partialConclusion(text: string): string {
  // 第一步：定位值的起点。任何一步还不完整就直接放弃 —— 还没到该说话的时候。
  const keyAt = text.indexOf(KEY);
  if (keyAt === -1) return '';

  let cursor = skipWhitespace(text, keyAt + KEY.length);
  if (text[cursor] !== ':') return '';
  cursor = skipWhitespace(text, cursor + 1);
  if (text[cursor] !== '"') return '';

  // 第二步：从开引号往后解码。
  return decodeString(text, cursor + 1);
}

function skipWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && ' \t\n\r'.includes(text[cursor] as string)) {
    cursor += 1;
  }
  return cursor;
}

function decodeString(text: string, from: number): string {
  let out = '';
  let cursor = from;

  while (cursor < text.length) {
    const char = text[cursor] as string;

    if (char === '"') return out; // 字符串正常结束
    if (char !== '\\') {
      out += char;
      cursor += 1;
      continue;
    }

    // ---- 以下是转义序列 ----
    // 「解不出来就停」对「chunk 断在转义中间」和「文本到此为止」是同一个动作，
    // 所以不需要为前者写任何特判。
    const next = text[cursor + 1];
    if (next === undefined) return out; // 反斜杠在末尾，还等下一个字符

    switch (next) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u': {
        const decoded = decodeUnicodeEscape(text, cursor);
        if (decoded === null) return out; // 码位还没到齐，停下等
        out += decoded.value;
        cursor += decoded.length;
        continue;
      }
      default:
        // 非法转义。真实模型偶尔会写出 `\x` 这类东西 —— 照字面收下，
        // 算不算数交给最终那次 parseAnswer 定。
        out += next;
        break;
    }

    cursor += 2;
  }

  return out;
}

/**
 * 解一个 `\uXXXX`，必要时把代理对拼成一个字符。
 *
 * 这是整个解析器里唯一「不吐会更好」的地方：代理对的两个码元分属两次 chunk 时，
 * 只吐前一半会得到一个半个字符 —— 页面上显示成乱码方块。所以宁可等，
 * 也不能吐半个。
 *
 * 但「等」必须有个止境：如果已经流到的部分能**证明**这是个孤立的代理
 * （后面跟的不是 `\u`），那就照实吐出去，别让这段永远卡住。
 */
function decodeUnicodeEscape(
  text: string,
  backslashAt: number,
): { value: string; length: number } | null {
  const hex = text.slice(backslashAt + 2, backslashAt + 6);
  if (!HEX4.test(hex)) return null; // 四位还没到齐，或者根本不是十六进制

  const code = parseInt(hex, 16);

  // 不是高位代理，一个码元就是一个字符。
  if (code < 0xd800 || code > 0xdbff) {
    return { value: String.fromCharCode(code), length: 6 };
  }

  // 是高位代理，得看后面有没有低位代理。
  const lowAt = backslashAt + 6;
  const looksLikeLowEscape =
    text[lowAt] === '\\' && text[lowAt + 1] === 'u';

  if (looksLikeLowEscape) {
    const lowHex = text.slice(lowAt + 2, lowAt + 6);
    if (!HEX4.test(lowHex)) {
      // 还没到齐 → 等。已经到齐但不是十六进制 → 那它不可能是低位代理，吐孤立的。
      return lowHex.length < 4
        ? null
        : { value: String.fromCharCode(code), length: 6 };
    }

    const low = parseInt(lowHex, 16);
    if (low >= 0xdc00 && low <= 0xdfff) {
      return { value: String.fromCharCode(code, low), length: 12 };
    }

    return { value: String.fromCharCode(code), length: 6 };
  }

  // 后面不是 `\u`。但这里要分清「还没流到」和「确定不是」：
  // 后者能证明这是个**孤立**的代理，那就照实吐出去，别让这段永远卡住。
  if (lowAt >= text.length) return null; // 后面什么都还没到，等
  if (text[lowAt] === '\\' && lowAt + 1 >= text.length) {
    return null; // 到了一个反斜杠，但后面那个字符还没到，等
  }

  return { value: String.fromCharCode(code), length: 6 };
}
