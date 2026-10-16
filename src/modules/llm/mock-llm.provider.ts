import { Logger } from '@nestjs/common';
import type {
  LlmCompletion,
  LlmMessage,
  LlmProvider,
  LlmRequestOptions,
  LlmStream,
} from './llm.types.js';

/**
 * 假模型。
 *
 * ⚠️ 先说清楚它**不是**什么：它不是模型，是一张**规则表**。它按问题里的关键词
 * 查表，把报销单数据里的字段拼成一句中文。它不会推理，也答不出规则表以外的任何问题。
 *
 * 那它有什么用？—— 让**管道**能被测。真实模型的输出是不可复现的，而这个项目的产物
 * 是「取数 → 组 prompt → 调用 → 解析 → 校验字段」这条链路。用假模型，链路的每一步
 * 都能写断言；换成真模型，只有最终答案能写断言。
 *
 * 它也**不能**证明「模型答得准」—— 那要靠评测集，而且必须在真模型上跑。
 * 这两件事别混为一谈。
 *
 * 故意保留的两处「不老实」，因为真实模型天天这么干，管道必须扛得住：
 *   1. 把 JSON 包在 ```json 代码块里（真实模型极爱这么写）
 *   2. 偶发地引用一个不存在的字段名 —— 见 MISBEHAVE 环境变量
 */

/** 状态和分类的枚举值在界面上要显示成中文，否则结论读起来像日志。 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  SUBMITTED: '已提交、待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  PAID: '已打款',
};

const CATEGORY_LABEL: Record<string, string> = {
  TRAVEL: '差旅',
  OFFICE: '办公',
  ENTERTAIN: '招待',
  TRANSPORT: '交通',
  OTHER: '其他',
};

interface MockItem {
  name?: string;
  category?: string;
  amount?: string;
  spentOn?: string;
}

interface MockRecord {
  code?: string;
  title?: string;
  applicant?: string;
  department?: string;
  category?: string;
  amount?: string;
  status?: string;
  submittedAt?: string;
  decidedAt?: string;
  rejectReason?: string;
  items?: MockItem[];
}

interface MockAnswer {
  conclusion: string;
  evidence: string[];
  insufficient: boolean;
}

/** 取不到数据时的回答 —— 故意返回非 JSON，让上层的解析失败路径真的会被走到。 */
const NO_DATA: MockAnswer = {
  conclusion: '我拿不到报销单数据，无法回答。',
  evidence: [],
  insufficient: true,
};

function shortDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : '（无）';
}

/** 一句话概括这张单子，兜底规则用。 */
function summarize(record: MockRecord): MockAnswer {
  const status = STATUS_LABEL[record.status ?? ''] ?? record.status ?? '未知';
  return {
    conclusion: `${record.code}（${record.title}）由${record.applicant}提交，金额 ¥${record.amount}，当前状态：${status}。`,
    evidence: ['code', 'title', 'applicant', 'amount', 'status'],
    insufficient: false,
  };
}

/**
 * 规则表。从上往下第一个命中的生效 —— 顺序有意义，
 * 「为什么被驳回」必须排在「什么时候」前面，否则「驳回是什么时候的事」会走错分支。
 */
const RULES: Array<{ match: RegExp; answer: (record: MockRecord) => MockAnswer }> = [
  {
    match: /驳回|拒绝|不通过|没通过/,
    answer: (record) =>
      record.rejectReason
        ? {
            conclusion: `${record.code} 已被驳回，驳回原因：${record.rejectReason}`,
            evidence: ['code', 'status', 'rejectReason'],
            insufficient: false,
          }
        : {
            conclusion: `${record.code} 当前状态不是「已驳回」，数据里没有驳回原因。`,
            evidence: ['code', 'status'],
            insufficient: true,
          },
  },
  {
    match: /明细|构成|花在|什么费用|哪些费用|项目/,
    answer: (record) => {
      const items = record.items ?? [];
      if (items.length === 0) {
        return {
          conclusion: `${record.code} 没有任何费用明细。`,
          evidence: ['code', 'items'],
          insufficient: true,
        };
      }
      const lines = items
        .map(
          (item) =>
            `${item.name}（${CATEGORY_LABEL[item.category ?? ''] ?? item.category}）¥${item.amount}`,
        )
        .join('；');
      return {
        conclusion: `${record.code} 共 ${items.length} 条明细：${lines}。合计 ¥${record.amount}。`,
        evidence: ['code', 'items', 'amount'],
        insufficient: false,
      };
    },
  },
  {
    match: /多少钱|金额|总额|合计|花了多少/,
    answer: (record) => ({
      conclusion: `${record.code} 的报销金额是 ¥${record.amount}。`,
      evidence: ['code', 'amount'],
      insufficient: false,
    }),
  },
  {
    match: /审批|审批意见|批准|决定|决策|通过了吗/,
    answer: (record) =>
      record.decidedAt
        ? {
            conclusion: `${record.code} 已于 ${shortDate(record.decidedAt)} 完成审批，当前状态：${
              STATUS_LABEL[record.status ?? ''] ?? record.status
            }。`,
            evidence: ['code', 'status', 'decidedAt'],
            insufficient: false,
          }
        : {
            conclusion: `${record.code} 还没走到审批环节（${
              STATUS_LABEL[record.status ?? ''] ?? record.status
            }），数据里没有审批意见。`,
            evidence: ['code', 'status'],
            insufficient: true,
          },
  },
  {
    match: /提交|什么时候提|时间|日期/,
    answer: (record) => ({
      conclusion: `${record.code} 的提交时间是 ${shortDate(record.submittedAt)}。`,
      evidence: ['code', 'submittedAt'],
      insufficient: false,
    }),
  },
];

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockLlmProvider.name);

  async complete(
    messages: LlmMessage[],
    _options?: LlmRequestOptions,
  ): Promise<LlmCompletion> {
    const record = extractRecord(messages);
    const question = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';

    const answer = record
      ? (RULES.find((rule) => rule.match.test(question))?.answer(record) ??
        summarize(record))
      : NO_DATA;

    const misbehaved = this.maybeMisbehave(answer);

    return {
      // 包一层代码块 —— 真实模型十次有八次这么干，解析器必须能吃下去。
      text: `\`\`\`json\n${JSON.stringify(misbehaved, null, 2)}\n\`\`\``,
      model: `${this.name}/rule-table`,
    };
  }

  /**
   * 假流式。
   *
   * ⚠️ 先给结论定性：**这不是真流式**。它先调 `complete()` 把整段答案都拿到手，
   * 再把文本切块、每块之间 sleep 一下吐出去。真流式的核心收益 —— 首字延迟
   * （模型开始说话到第一个字出现的时间）—— 它一点都吃不到，因为整段答案
   * 早就生成完了。
   *
   * 那为什么还这么做：它让**管道**是流式的。前端的分帧、增量解析、断线中止
   * 这些代码路径，用假流式一样能测、能跑通、能演示。这些才是要写的东西。
   * 换成真厂商后，这些代码一行都不用改 —— 只有首字延迟会从 0 变成真实值。
   *
   * 别把「流式管道能用」说成「我做过流式优化」：后者得先有真实的首字延迟数字。
   */
  async stream(
    messages: LlmMessage[],
    options?: LlmRequestOptions,
  ): Promise<LlmStream> {
    // 信封（model）在**写第一个字之前**就确定 —— 这是 LlmStream 这个形状的意义。
    const completion = await this.complete(messages, options);

    return {
      model: completion.model,
      chunks: chunkify(completion.text, options?.signal),
    };
  }

  /**
   * 让假模型按需「学坏」，用来验证防幻觉的那道校验真的会拦东西。
   *
   * 默认关闭 —— 开着的话测试就不稳定了。要验证拦截逻辑时：
   *   MOCK_MISBEHAVE=unknown-field
   */
  private maybeMisbehave(answer: MockAnswer): MockAnswer {
    if (process.env.MOCK_MISBEHAVE !== 'unknown-field') return answer;

    this.logger.warn('MOCK_MISBEHAVE=unknown-field：本次回答故意引用一个不存在的字段');
    return { ...answer, evidence: [...answer.evidence, 'approverSignature'] };
  }
}

/** 每块几个字。故意取小值，让 chunk 边界经常落在多字节字符和转义序列中间。 */
const CHUNK_SIZE = 6;
/** 块之间的间隔。太小看不出「一个字一个字出来」，太大测试变慢。 */
const CHUNK_DELAY_MS = 25;

async function* chunkify(
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) return;
    await delay(CHUNK_DELAY_MS, signal);
    yield text.slice(offset, offset + CHUNK_SIZE);
  }
}

/**
 * 可被中止的 sleep。
 *
 * 不处理中止的话，用户关掉页面后这个循环还会把剩下的块全部吐完才结束 ——
 * 每块 25ms，一段答案能白白跑一两秒。对真模型来说那是实打实的 token 钱。
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    let timer: NodeJS.Timeout;

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(() => {
      // 正常走完就把监听摘掉，否则每块都会往同一个 signal 上挂一个监听，
      // 长回答会积出一堆（Node 对 AbortSignal 的监听器数量是有上限告警的）。
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 从 prompt 里把报销单数据抠出来。
 *
 * 之所以要「抠」而不是「传」：`LlmProvider` 的入参只有 messages —— 这是和真实厂商
 * 唯一的共同语言。假模型不能给自己开一条只有它有的旁路，否则换真模型时管道就断了。
 * 代价是这个正则很脆，但脆的是假模型，不是产品代码。
 */
function extractRecord(messages: LlmMessage[]): MockRecord | null {
  const prompt = messages.map((m) => m.content).join('\n');
  const blocks = [...prompt.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return null;

  try {
    return JSON.parse(last) as MockRecord;
  } catch {
    return null;
  }
}
