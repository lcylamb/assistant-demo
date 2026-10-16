/**
 * `/assistant/ask` 的返回结构。
 *
 * 三个字段缺一不可，而且**都是给用户看的**：
 *   · conclusion   —— 结论，一句话
 *   · evidence     —— 依据来自哪几个字段。用户能顺着它去核对，所以这是「可验证性」的载体
 *   · insufficient —— 数据不够时必须显式为 true，而不是让模型编一个听起来合理的答案
 *
 * 这个结构一旦定下来就不该轻易改：流式端点、评测断言都建立在它上面。
 */
export interface AskResult {
  conclusion: string;
  /** 用到的字段路径，取值必须来自 ExpenseContext.availableFields */
  evidence: string[];
  /** 数据是否不足以回答 */
  insufficient: boolean;
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
