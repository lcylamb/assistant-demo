# assistant-demo

[![CI](https://github.com/lcylamb/assistant-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/lcylamb/assistant-demo/actions/workflows/ci.yml)

**[English](README.md)**

用自然语言提问一张报销单，返回**结构化、可校验**的回答：结论、依据字段，以及数据是否不足以回答。答案通过 SSE 逐块返回。

`npm run start:dev` 之后打开 <http://localhost:3100>。默认使用 mock provider，不需要任何 API key。

## 特性

- **结构化输出**：模型必须返回 JSON；完整答案逐字段校验，不合格返回 `502`，不会把半个答案交给用户。
- **依据可核对**：`evidence` 只接受本次实际查询过的字段，不存在的字段会被剔除并记录。
- **工具调用**：模型通过 3 个只读工具自行取数；单号由服务端绑定，模型无法指定其他单据。
- **流式输出**：从半截 JSON 中增量提取结论；流式与非流式共用同一套最终校验。接入真实厂商时为首字即达的真流式，mock 为分块模拟。
- **多轮对话**：客户端回传上一轮的结构化结论，服务端不保存会话。
- **可评测**：23 条用例覆盖工具轨迹、提示注入和越权，CI 使用真实数据库运行。
- **可观测**：请求 id、访问日志、延迟 / 首字 / token / 成本指标、被拒绝请求计数。
- **默认 mock**：规则表 provider 让全部测试无需网络与密钥即可复现。

## 快速开始

前置：Node 20+、Docker。

```bash
cp .env.example .env      # 默认连接本机 5433 上的 PostgreSQL
npm install
npm run db:up             # 启动 PostgreSQL 容器
npm run db:migrate        # 建表
npm run db:seed           # 写入 10 张虚构报销单
npm run start:dev         # http://localhost:3100
```

常用脚本：

| 命令 | 作用 |
|---|---|
| `npm run db:reset` | 清库并重新 seed |
| `npm run db:studio` | 数据浏览器（localhost:5555） |
| `npm run probe:stream` | 请求流式端点，打印每块数据的到达时间 |
| `npm run eval` / `eval:real` | 用 mock / 真实模型运行评测 |
| `npm run lint` / `npm test` / `npm run test:e2e` | 静态检查与测试 |
| `docker compose up --build` | 数据库 + 迁移 + 应用，整套运行在容器里 |

## 用法

### 一次性问答

```bash
curl -X POST localhost:3100/assistant/ask \
  -H 'Content-Type: application/json' \
  -d '{"code":"BX-2026-0003","question":"这张单子为什么被驳回了？"}'
```

```json
{
  "conclusion": "BX-2026-0003 已被驳回，驳回原因：招待费超出部门月度预算，且缺少参与人员清单",
  "evidence": ["code", "status", "rejectReason"],
  "insufficient": false,
  "trace": [{ "tool": "get_approval_record", "ok": true }],
  "metrics": {
    "elapsedMs": 912,
    "ttftMs": null,
    "modelCalls": 2,
    "toolMs": 18,
    "usage": { "promptTokens": 1820, "completionTokens": 96 }
  }
}
```

数据中没有答案时，返回值明确标记为信息不足：

```json
{
  "conclusion": "BX-2026-0005 还没走到审批环节（草稿），数据里没有审批意见。",
  "evidence": ["code", "status"],
  "insufficient": true,
  "trace": [{ "tool": "get_approval_record", "ok": true }]
}
```

### 流式

`POST /assistant/askStream` 的请求体相同，响应为 `text/event-stream`：

```
event: delta
data: {"text":"这张"}

event: delta
data: {"text":"单子"}

event: done
data: {"conclusion":"…","evidence":["status"],"insufficient":false,"trace":[…],"metrics":{…}}

event: error
data: {"message":"模型调用失败，请重试"}
```

`delta` 是增量文本，可能被后续内容修正；只有 `done` 是最终结果，其结构与 `/assistant/ask` 完全相同。空闲超过 `SSE_HEARTBEAT_MS` 时服务端发送注释帧 `: ping`，客户端应按 SSE 规范忽略。

### 多轮对话

在请求体中传入 `history`，内容为上一轮经过校验的结论：

```json
{
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
}
```

最多 3 轮；历史只作为上下文，不扩大本轮可引用的字段范围。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/assistant/ask` | 一次性返回 `AskResult` |
| `POST` | `/assistant/askStream` | SSE：`delta` → `done`，或中途 `error` |
| `GET` | `/assistant/metrics` | 进程内指标快照 |
| `GET` | `/health` | 执行一次 `select 1`，数据库不可用时返回 `503` |

所有响应带 `X-Request-Id`，日志中以 `[req <id>]` 关联同一次请求。

| 状态码 | 含义 |
|---|---|
| `400` | 入参校验失败 |
| `404` | 单号不存在 |
| `429` | 触发限流、并发上限或日额度 |
| `502` | 模型调用失败，或输出无法通过格式校验 |
| `503` | 数据库不可用 |
| `504` | 超过单次提问总预算 |

流式端点开始写响应头之后无法修改状态码，因此调用失败、格式异常、数据库中途不可用表现为 `200` + `error` 帧。

## 设计概览

```
请求 → 参数校验 → 限流 / 并发守卫 → 查询单号 → Agent 循环（模型 ↔ 工具）→ 解析与剔除 → 响应
```

几个关键选择：

- **输出不可信任。** 完整答案经过类型校验；依据字段必须来自本次工具返回值，否则剔除。返回 `502` 只用于格式错误，不用于「措辞不够好」。
- **工具参数里没有单号。** 单号由服务端绑定；不提供全表搜索。模型可触及的数据范围由服务端决定。
- **流式不另起一套解析。** 两条端点共用 `prepare()` 和 `settle()`；增量文本在流结束后仍要经过完整校验。
- **取消信号早于响应头。** 流式端点在查询单号之前就监听连接关闭，客户端提前离开时不会调用模型或消耗额度。
- **三层限制。** 频率、并发、日额度分别处理刷接口、请求堆积和额度耗尽。
- **错误按来源分类。** 厂商故障是 `502`，数据库故障是 `503`，超时是 `504`，用户取消不计入错误。

详见 [docs/design.md](docs/design.md)。

## 评测

23 条用例，每条同时请求两条端点；期望值大多从数据库计算得出，不是手写常量。

```
npm run eval        （mock）   ：通过 13　已知不足 10　不符预期 0
npm run eval:real   （DeepSeek）：通过 23　已知不足 0　不符预期 0
```

- 结构底线永远算失败，不豁免：依据字段必须存在、金额与日期必须可溯源、工具不能失败、确定性 provider 下两条端点结论相同。
- 轨迹断言要求每条用例调用指定工具，避免「答案碰巧正确」。
- mock 上的 10 条已知不足对应规则表缺失的能力；真实模型上全部通过。
- 评测通过注入变异验证过会失败，因此全绿不是「断言失效」。

用例表、判定层次与真实模型结果见 [docs/evaluation.md](docs/evaluation.md)。

## 测试与 CI

```bash
npm test          # 单元测试，不依赖数据库
npm run test:e2e  # 端到端测试与评测，需要数据库
npm run lint      # oxlint（含类型检查）
```

CI 每次 push / PR 执行 `lint` → `tsc --noEmit` → `build` → 单元测试 → 端到端测试。数据库由 Actions service 容器提供，每次从零迁移并 seed；末尾构建并启动真实容器，验证探活、一次请求、镜像中无密钥、进程非 root、`docker stop` 正常退出。

CI 只运行 mock；真实模型评测在本地手动执行。

## 配置

主要变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` 或 `openai`（OpenAI 兼容协议） |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | — | `openai` 模式必填 |
| `RATE_LIMIT_PER_MINUTE` | `30` | 每 IP 每分钟请求数 |
| `MAX_CONCURRENT_ASKS` | `8` | 同时在途的模型请求上限，`0` 关闭 |
| `LLM_DAILY_LIMIT` | 关闭 | 每日模型调用上限 |
| `ASK_TIMEOUT_MS` | `90000` | 单次提问总预算 |
| `LLM_TIMEOUT_MS` | `30000` | 单轮调用上限 |
| `SSE_HEARTBEAT_MS` | `15000` | 流式空闲心跳间隔 |
| `TRUST_PROXY` | 未设置 | 反向代理跳数，仅在确实有代理时设置 |

换成真实模型只需修改 `.env`，代码无需改动：

```bash
LLM_PROVIDER=openai
LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

`npm run eval:real` 会用同一份评测集重新运行。

完整列表与取值说明见 [`.env.example`](.env.example) 和 [docs/operations.md](docs/operations.md)。

## 部署

```bash
docker compose up --build   # 数据库 + 迁移 + 应用
```

镜像分五段构建，运行时以非 root 执行，不包含密钥；启动时检查数据库，关闭时不等待活跃连接。部署目标为 Render + Neon，迁移需从本机手动执行一次。

细节见 [docs/operations.md](docs/operations.md)。

## 已知限制

这是一个演示项目，不是生产系统：

- 没有权限体系与多租户隔离；
- 指标、限流、并发上限、日额度都保存在单个进程的内存中，多实例各算各的、重启清零；
- 没有 tracing、日志聚合或跨实例聚合；
- 增量解析器不保证 `conclusion` 是顶层键，兜底是流结束后的完整校验；
- 成本估算不含缓存价，结果是上界而非账单；
- mock 的 token 用量按字符数估算，不是分词器结果；
- 真实模型评测是一次采样，输出不保证可复现。

范围之外：RAG（数据本身是结构化的，直接查库更合适）、复杂 Agent 编排、消息持久化。

## 数据

仓库中的所有数据均为虚构：姓名为「张三 / 李四 / 王五 / 赵六 / 孙七」等占位名，不含真实人员、证件号、手机号，也没有来自真实业务系统的数据。金额同样是编造的。

seed 写入 10 张报销单，覆盖草稿、待审批、已通过、已驳回、已支付等状态，用于评测中的正常路径与陷阱用例。
