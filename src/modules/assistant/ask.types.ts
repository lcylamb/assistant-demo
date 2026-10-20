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
 * `/assistant/ask` 的返回结构。
 *
 *   · conclusion   —— 结论，一句话
 *   · evidence     —— 依据来自哪几个字段。用户能顺着它去核对，所以这是「可验证性」的载体
 *   · insufficient —— 数据不够时必须显式为 true，而不是让模型编一个听起来合理的答案
 *   · trace        —— 这次答出来之前，模型**自己决定**调了哪些工具
 *
 * trace 是给「这个回答是怎么来的」一个可检查的答案。它同时是评测轨迹断言的输入：
 * 没有它，轨迹只能靠刮日志，而日志格式本来就是会变的。
 */
export interface AskResult extends ParsedAnswer {
  trace: AgentStep[];
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
