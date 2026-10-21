# 设计与实现

本文说明 assistant-demo 的内部结构和主要设计选择。运行方式见 [README](../README.md)。

## 架构

```
src/
├─ main.ts                    进程入口
├─ app-setup.ts               中间件、全局管道、日志器（main 与 e2e 共用）
├─ app.module.ts              配置、限流、模块装配
├─ modules/
│  ├─ assistant/
│  │  ├─ assistant.controller.ts       HTTP 与 SSE 分帧
│  │  ├─ assistant.service.ts          取数、Agent 循环、结果收口
│  │  ├─ ask.dto.ts                    入参校验
│  │  ├─ parse-answer.ts               完整答案的格式校验
│  │  ├─ stream-parse.ts               从半截 JSON 中提取增量结论
│  │  ├─ expense-context.ts            可引用字段清单
│  │  ├─ tools/                        三个只读工具
│  │  ├─ assistant-metrics.service.ts  进程内指标
│  │  ├─ model-concurrency.guard.ts    并发上限
│  │  └─ daily-quota.service.ts        日额度
│  ├─ llm/
│  │  ├─ llm.types.ts                  provider 接口
│  │  ├─ mock-llm.provider.ts          规则表（默认）
│  │  ├─ openai-compatible.provider.ts 真实厂商
│  │  └─ llm.module.ts                 provider 工厂
│  └─ prisma/                          连接、健康检查、故障分类
├─ request-context.ts         请求 id 与日志上下文
├─ access-log.ts              访问日志
└─ ip-throttler.guard.ts      按 IP 统一计数的限流守卫

public/index.html             演示页
scripts/ask-stream-probe.mjs  裸流探测脚本
test/                         e2e 与评测
```

一次请求的路径：

1. 中间件生成或沿用请求 id，开启访问日志计时；
2. `ValidationPipe` 按 DTO 校验并剔除多余字段；
3. 全局限流守卫与并发守卫在进入业务之前拒绝超限请求；
4. `prepare()` 查询单号，组装系统提示与工具定义；
5. Agent 循环：模型决定调用哪些工具 → 服务端执行 → 结果回传模型，最多 4 轮；
6. `settle()` 解析最终答案、剔除不存在的依据字段、记录指标；
7. 非流式返回 JSON；流式在过程中持续输出 `delta`，最后输出 `done`。

两条端点共用 `prepare()` 与 `settle()`，能产生漂移的地方只有一处，并由评测中「两条端点结论相同」的断言覆盖。

Provider 实现的是协议而不是厂商：业务代码只依赖 `LLM_PROVIDER` 令牌，具体服务由 `LLM_BASE_URL` 与 `LLM_MODEL` 决定。只要兼容 OpenAI 的 `/chat/completions` 协议，就可以直接切换。

## 输出格式校验

模型必须输出 JSON。`parse-answer.ts` 先取第一个 `{` 到最后一个 `}`（兼容代码块与前后寒暄），再逐字段校验类型；任一条件不满足即返回 `502`，不会把半个答案返回给用户。

它是纯函数，测试覆盖 24 种输入，包括缺字段、类型错误、被截断、包裹代码块等。

## 防幻觉

模型声明的依据字段（`evidence`）必须来自**本次实际调用过的工具返回的字段**。清单由工具返回值遍历生成（`expense-context.ts` 的 `fieldsOf`），不是手写白名单；范围也只限本次查询，模型没查审批记录却引用 `rejectReason` 同样会被剔除。

引用清单之外的字段不会导致请求失败，而是从 `evidence` 中移除并记录一条 warn。理由是多写一个字段名通常只是措辞瑕疵，为此返回 `502` 会让小毛病变成错误页；剔除保证的是「用户看到的依据一定真实存在」。

可以手动触发这条防线：

```bash
MOCK_MISBEHAVE=unknown-field npm run start:dev
# 日志：模型引用了不存在的字段，已剔除：[approverSignature]（单号 BX-2026-0003）
```

> 剔除只保证 `evidence` 不撒谎，不保证 `conclusion` 因此正确。结论质量由评测回答。

## 工具调用

模型不直接拿到整张单子，只拿到单号和问题，通过三个只读工具取数：

| 工具 | 查询内容 | 可引用字段示例 |
|---|---|---|
| `get_expense_summary` | 表头：申请人、部门、金额、状态、提交时间 | `amount`、`submittedAt` |
| `list_expense_items` | 明细与合计 | `items[0].name`、`items[0].spentOn` |
| `get_approval_record` | 审批：决策时间、驳回原因 | `status`、`rejectReason` |

循环最多 4 轮。`trace` 记录实际执行了哪些工具以及是否成功，由服务端生成，不采信模型的自我描述。

三个安全边界：

1. **工具参数中没有单号**。单号由服务端从本次请求绑定，模型无法指定，避免一句注入的提问读取其他单据。
2. **不提供全表搜索或条件查询**。模型可触及的数据范围由服务端决定，不由模型输出决定。
3. **可引用字段 = 本次实际查询结果**。比「整张单子的字段全集」更严格，也会拦住「没查过就引用」。

工具消息的三个实现细节：

- assistant 轮次必须原样回传 `tool_calls`，否则下一轮厂商无法配对；
- 工具结果必须带 `tool_call_id`，配对依据是 id 而不是函数名（并行调用同一工具时名字不够用）；
- 工具执行失败也必须回一条 tool 消息，否则下一轮请求结构不完整，厂商会直接返回 400。

## 多轮对话

服务端不保存会话。历史由客户端在每次请求中回传，形状是**上一轮经过校验的结构化结论**：

```bash
curl -s localhost:3100/assistant/ask \
  -H 'content-type: application/json' \
  -d '{
    "code": "BX-2026-0002",
    "question": "那这钱都花在哪些项目上了？",
    "history": [
      {
        "question": "这张单子一共多少钱？",
        "conclusion": "BX-2026-0002 的报销金额是 ¥12800.00。",
        "evidence": ["code", "amount"],
        "insufficient": false
      }
    ]
  }'
```

选择结构化摘要而不是原始对话，原因有三：

- token 不随轮数线性增长；
- 不会把未经 `parseAnswer` 与防幻觉校验的中间产物带入下一轮；
- 模型看到的历史与它自己产出的结果形状一致，指代消解更容易对上。

历史被渲染成 user 消息中的一个 JSON 数据块，而不是还原成 `role: "assistant"` 轮次。原因是这份历史由客户端提供，渲染成模型发言等于允许调用方冒充模型把内容带进上下文。

DTO 固定了上限：3 轮、每轮结论 500 字、16 个依据字段、问题 200 字。这是客户端唯一能向 prompt 注入内容的路径，而额度按调用次数计算。

历史只是上下文，不是依据：防幻觉清单仍然只认本轮工具实际返回的字段。上一轮查过、这一轮没查的字段，引用照样会被剔除。

## 流式输出

流式端点与普通端点共用 `prepare()`（组装上下文）和 `settle()`（解析与校验）。流式版本不会自己走一套解析，否则增量输出的文本就成了绕过校验的后门。

增量解析器 `partialConclusion()` 从可能不完整的 JSON 文本中提取 `conclusion` 已经解出的部分。实现上不做状态机，每次收到新数据就从头重扫整个缓冲区：

- 重扫是幂等的，同一段文本永远得到同一结果，没有「停在转义序列中间」这种状态可出错；
- 代价是整体 O(n²)，但 n 是一句话的长度；
- 断在转义序列或代理对中间时，无法解码的部分等待下一块数据。

流结束后，完整文本仍交给同一个 `parseAnswer` 校验，通过后才发送 `done`。页面在 `done` 之前显示的内容随时可能被最终结果覆盖。

> `MockLlmProvider.stream()` 先得到完整答案再分块输出，是模拟流式，不产生真实的首字延迟。切换到真实 provider 后管道代码不变，首字延迟才反映厂商的实际响应速度。

### 心跳

工具轮期间可能数秒没有字节发给客户端：第一轮模型只返回工具调用，接着查库，第二轮才产生第一个字。这段时间连接对代理是空闲的，nginx 的 `proxy_read_timeout` 默认 60 秒、Cloudflare 为 100 秒，超时会直接断开。

服务端在空闲超过 `SSE_HEARTBEAT_MS`（默认 15 秒）后发送 SSE 注释帧 `: ping`。规范要求客户端忽略注释帧，但它是一个真实字节，会重置代理的计时器。正常输出内容时不发送心跳。

## 取消、超时与重试

**客户端断开。** 两条端点都在响应的 `close` 事件且 `writableFinished` 为 false 时中止在途的模型调用。流式端点的取消监听从请求开始就挂上，早于查询单号（`prepare()`）；取数期间客户端离开时，不写响应头、不调用模型、不消耗额度。取消的请求记为 `aborted`，不计入 `errors`。

**单轮超时。** `LLM_TIMEOUT_MS` 在非流式中是整个调用上限；在流式中它约束两件事：等待第一个字的时间，以及相邻两帧之间允许的最长沉默。不限制整条流的总时长，避免正常但较慢的长回答被截断。

**总预算。** `ASK_TIMEOUT_MS` 覆盖从 Agent 循环开始到收口的全部时间。超时后不再开始新的模型轮次：非流式返回 `504`，流式发送 `error` 帧。预算耗尽与客户端取消都会中止 signal，但两者分开判断：前者需要告知用户，后者静默结束。

**重试。** 连接失败、`429`、`5xx` 最多尝试 `LLM_MAX_ATTEMPTS` 次（默认 3，含第一次），退避带满抖动，避免一批实例在同一时刻重试；厂商返回 `Retry-After` 时遵循该值，但超过 2 秒直接失败，避免让用户长时间等待。鉴权、余额、参数错误与已超时的调用不重试。流式只在第一个字之前重试，开始输出后重试会重复内容。

## 限流、并发与日额度

三层限制，分别针对不同问题：

| 限制 | 默认值 | 防止的问题 |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | 30 次/分/IP | 单个脚本高频请求压垮服务 |
| `MAX_CONCURRENT_ASKS` | 8，0 关闭 | 请求堆积：30 次/分 × 单次最长 90 秒，最坏会同时存在数十个调用 |
| `LLM_DAILY_LIMIT` | 关闭 | 大量 IP 各刷几次，烧光模型额度 |

限流的计数 key 由 IP 决定，两个模型端点共用一份额度（库默认按端点各算一份）。`/health` 与 `/assistant/metrics` 豁免：探活被限流会让平台误判实例不健康并反复重启，指标接口被限流则会影响观察。

并发上限在守卫中执行，因此被拒绝的请求拿到的是正常的 `429` JSON，而不是已经开始的流。额度在响应 `finish` 或 `close` 时归还，且只归还一次。

三者的计数都在进程内存中，多实例部署时实际限制是配置值的 N 倍。

## 可观测性

### 请求 id

每个响应带 `X-Request-Id`，日志每行带 `[req <id>]` 前缀。单号是业务键，不是请求键：两人同时查询同一张单时，日志会交错；请求 id 用来区分它们。

- 合法的传入值（`[A-Za-z0-9._:-]{8,64}`）会被沿用，以便与网关或前端的日志对齐；
- 不合法的值会被替换。该值会进入日志和响应头，需要防止换行注入；
- id 通过 `AsyncLocalStorage` 传递，不进入业务函数签名，只用于日志前缀。

### 访问日志

每个请求结束记录一行：

```
[req 6f1c…] GET /assistant/metrics 200 12ms
[req 9a2b…] POST /assistant/askStream 200 1834ms（流式）
[req c3d4…] POST /assistant/askStream 客户端断开 812ms
```

只记录 `/assistant/*` 的成功请求，以及任意路径上的 `4xx/5xx`：探活与静态资源访问频率高、信息量低，但 404 扫描和限流拒绝需要可见。

客户端断开通过 `writableFinished` 判断，而不是状态码——断开时状态码仍为 200。流式请求记录整条流的耗时，因此单独标注。

### 指标

`/assistant/metrics` 返回进程内快照：

```json
{
  "provider": "openai-compatible",
  "uptimeMs": 4417132,
  "windowSize": 200,
  "totals": {
    "requests": 42, "ok": 40, "errors": 1, "aborted": 1,
    "modelCalls": 71, "toolCalls": 33,
    "promptTokens": 91240, "completionTokens": 6180,
    "requestsWithUsage": 42, "requestsWithoutUsage": 0
  },
  "latencyMs": { "samples": 41, "p50": 1180, "p95": 3900, "max": 5120, "avg": 1442 },
  "ttftMs":    { "samples": 39, "p50": 640,  "p95": 1500, "max": 2210, "avg": 702 },
  "rejections": { "rateLimit": 3, "concurrency": 0, "quota": 0 },
  "cost": {
    "currency": "CNY", "amount": 0.232,
    "inputPerMillion": 2, "outputPerMillion": 8,
    "coveredRequests": 42, "uncoveredRequests": 0
  }
}
```

口径：

| 字段 | 计算方式 | 原因 |
|---|---|---|
| `elapsedMs` | 从 `prepare()` 到结论产出 | 包含单号查询，这是用户实际等待的时间 |
| `ttftMs` | 到第一个增量字到达客户端 | 包含准备阶段与工具轮，反映用户感知的「开始响应」 |
| token | 逐轮累加厂商返回的 `usage` | 一次请求可能调用多次模型，只取最后一轮会少算 |
| `latencyMs` | 只统计 `ok` / `error` | 被取消的请求时长是下界，混入会把 p95 拉低 |
| `ttftMs` | 包含被取消的请求 | 首字确实发生过 |
| 百分位 | nearest-rank，不插值 | 返回的一定是真实观测值 |
| 窗口 | 最近 200 条 | 内存有上界；总计数使用 O(1) 累加器 |

`totals` 只统计进入 service 的请求。被限流、并发上限或日额度挡下的请求另记在 `rejections` 中，按原因分开；两本账不能相加。日额度只在第一轮就被挡住时计入 `quota`，跑到中途才触顶的请求已经产生过模型调用。

用量口径：任一轮没有返回 `usage`，整次请求的用量记为 `null`，不用部分数据估算。成本只有同时配置输入与输出单价时才计算，否则为 `null`；缓存价不建模，因此结果是按价目表估算的上界。

## 错误语义

### 厂商故障

| 故障 | 非流式 | 流式 | 指标 |
|---|---|---|---|
| 调用失败（鉴权 / 网络 / 超时） | `502`「模型调用失败，请重试」 | `200` + `error` 帧 | `errors` +1 |
| 返回非 JSON | `502`「模型回答格式异常，请重试」 | `200` + `error` 帧 | `errors` +1 |
| 流中途断开 | — | 已发送的 `delta` 保留，随后补 `error` 帧 | `errors` +1，不计入 `aborted` |

流式端点开始写响应头之后无法再改状态码，因此调用失败、格式异常都表现为 `200` + `error` 帧；只有在响应头发出之前就能确定的错误（参数、单号不存在、限流）仍是正常的 HTTP 状态码。

失败计入 `errors` 而不是 `aborted`：错在厂商，不在用户。两类混在一起，故障率与取消率就无法区分。

### 数据库故障

| 发生位置 | 非流式 | 流式 | 指标 |
|---|---|---|---|
| 查询单号（响应头之前） | `503`「数据库暂时不可用，请稍后重试」 | 普通 JSON `503` | 不记录 |
| 工具查询（流已开始） | `503` | `200` + `error` 帧 | `errors` +1 |

选择 `503` 而不是 `500`：`500` 的语义是服务端 bug，数据库不可用是基础设施问题，重试有意义。工具查询失败时也不会降级成 `insufficient: true`，因为那会让「服务故障」与「数据里确实没有」在响应中无法区分。

数据库错误的分类使用白名单（`src/prisma/database-unavailable.ts`），只识别连接层错误码（P1001、P1002、P1008、P1017、P2024 等）；P2002、P2025 这类业务错误照常处理。不认识的错误保持原样：宁可少报，不要错报。

已知取舍：查询单号阶段失败时还没有会话，因此不进入指标统计。数据库故障期间应查看日志与 `/health`。
