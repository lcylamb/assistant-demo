import type { LlmUsage } from '../llm/llm.types.js';

/**
 * 模型**自己**给出的那部分。
 *
 * 和 `AskResult` 分开是因为它只有三个字段是模型能写的：
 * trace 由服务端根据「实际执行了哪些工具」生成，绝不能让模型自述 ——
 * 「我查了审批记录」这句话如果是模型写的，恰好就是最该被校验的那种事实。
 */
export interface ParsedAnswer {
  conclusion: string;
  /** 用到的字段路径，取值必须来自**本次实际调用过的工具**返回的字段 */
  evidence: string[];
  /** 数据是否不足以回答 */
  insufficient: boolean;
}

/** 一次工具调用。只记名字和成败 —— 参数和结果不进响应，那是日志的事。 */
export interface AgentStep {
  tool: string;
  ok: boolean;
}

/**
 * 这次请求的耗时和用量。**服务端生成**，和 trace 同一个立场：
 * 模型自述的数字不可信，而这是拿来算钱和排查慢请求的。
 *
 * 为什么也放进响应：页面上「查了表头 · 812 tokens · 1.2s」这句话，比任何一段
 * 「性能优化」的描述都更接近事实 —— 它每次都在被真实刷新。
 */
export interface AskMetrics {
  /** 端到端耗时，从 prepare() 开始（包含那一次单号查询）。 */
  elapsedMs: number;
  /** 第一个字到达客户端的耗时；非流式端点为 null。 */
  ttftMs: number | null;
  /** 模型轮数（工具循环跑了几轮）。 */
  modelCalls: number;
  /** 工具执行耗时之和。 */
  toolMs: number;
  /** 厂商报的用量；任一轮没报就是 null —— 0 不代表「没花钱」。 */
  usage: LlmUsage | null;
}

/**
 * `/assistant/ask` 的返回结构。
 *
 *   · conclusion   —— 结论，一句话
 *   · evidence     —— 依据来自哪几个字段。用户能顺着它去核对，所以这是「可验证性」的载体
 *   · insufficient —— 数据不够时必须显式为 true，而不是让模型编一个听起来合理的答案
 *   · trace        —— 这次答出来之前，模型**自己决定**调了哪些工具
 *   · metrics      —— 耗时与 token 用量
 *
 * trace 是给「这个回答是怎么来的」一个可检查的答案。它同时是评测轨迹断言的输入：
 * 没有它，轨迹只能靠刮日志，而日志格式本来就是会变的。
 */
export interface AskResult extends ParsedAnswer {
  trace: AgentStep[];
  metrics: AskMetrics;
}

/**
 * 一轮历史。**只有上一轮被校验过的结论**，没有原始文本、没有工具消息、没有 trace。
 *
 * 这是「上下文管理」的具体做法：回传给模型的是结构化摘要，不是把整段对话堆回去。
 * 好处有三个 —— token 不随轮数线性涨；历史里不会混进没被 `parseAnswer` 校验的中间产物；
 * 模型看到的历史和它给出的历史是同一种形状，指代消解时更容易对上号。
 */
export interface HistoryTurn extends ParsedAnswer {
  question: string;
}

/**
 * 流式端点往外发的事件。
 *
 * 判别联合而不是「一个可空字段一大堆的对象」：`type` 一收窄，消费方就**必须**
 * 处理 `done` 和 `error` 两条路，编译器逼着写 —— 而「流断了但没人管」
 * 恰好是流式接口最常见的坑。
 *
 * 注意 `done` 里带的是 `AskResult` 本身，和非流式端点**同一个类型**。
 * 两条路的最终产物必须一模一样，否则前端就得为它们写两套渲染。
 */
export type AssistantStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; data: AskResult }
  | { type: 'error'; message: string };
