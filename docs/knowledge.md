# 制度知识库问答（RAG + LangGraph）

`POST /knowledge/ask`：问制度，不问单据。assistant 模块答「这张单子怎么了」，
这个模块答「制度是怎么规定的」—— 语料是一份**虚构**的报销制度手册
（10 个章节，数字与单据数据互相咬合：BX-2026-0003 被驳回的两条理由都能在这里查到出处）。

```bash
curl -X POST localhost:3100/knowledge/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"招待费的上限是多少"}'
```

```json
{
  "answer": "业务招待费实行双重限制：单次招待人均不超过150元，且每部门每月招待费总额不超过3000元。",
  "sources": [{ "source": "3 餐饮招待", "score": 0.732 }],
  "queryRewritten": false
}
```

## 链路

文档切分（`RecursiveCharacterTextSplitter`）→ 本地 embedding → 向量检索 → LCEL 式组链 → 引用校验。
检索和生成之间用 **LangGraph** 编了一道检索质量判定：

```
START → retrieve → grade ─┬─(相关)──────────────→ generate → END
                          └─(不相关且未改写过)→ rewrite → retrieve（重查一轮）
```

问「年假有几天」这种手册没覆盖的问题时，这条分支真实走到过：
第一轮检索落空 → 改写重查 → 仍不相关 → 回答「制度中未覆盖」，`sources` 为空，
`queryRewritten: true`。改写只允许一轮，防止图里长出循环。

## 几个刻意的决定

- **embedding 用本地模型**（多语言 MiniLM，`.models` 目录缓存，首次运行自动下载，
  `HF_MIRROR` 指向镜像站）。DeepSeek 不提供 embeddings 端点，为十几章的语料
  再开一家供应商不值。
- **向量库是自己写的 60 行**。`@langchain/community` v1 砍掉了 MemoryVectorStore，
  于是按 `@langchain/core` 的 `VectorStore` 接口实现内存版（`memory-vector-store.ts`）：
  检索接口、retriever 语义全部对齐，将来换 pgvector 只动这一个文件。
- **不走项目的 `LlmProvider` 接口**。那层接口只有 complete/stream 两个原语，而这条
  链路要 LangChain 的模型抽象与向量库、图共用同一套 Runnable 体系。两个模块各用各的
  接入方式，本身就是「手写约束 vs 框架编排」的对照样本。
- **不做流式**。sources 要等引用校验结束才有意义，逐字流一个没校验的中间结果
  出去是假承诺 —— 和 assistant 模块流式结论（流的是同一收口逻辑的前缀）语义不同。
- **语料是编的，但数字咬合**。手册里的招待费标准与 BX-2026-0003 的驳回理由
  互相印证，两个模块的答案可以交叉对账。

## 边界

- 该模块**必须有真实模型**才能工作（mock provider 不覆盖它）：需要 `LLM_API_KEY`
  与可用的 OpenAI 兼容端点，以及本地 embedding 模型（首次运行下载约 90MB）。
- **内存是硬约束**：embedding 模型加载后进程 RSS 实测约 714MB（基线 87MB，
  量化 q8 + ONNX 运行时）。因此建库是**懒加载**的——第一次 `ask` 才切分、
  embedding、建索引，不调用就不占内存；小内存部署实例（Render 免费 512MB）
  装不下，必须设 `KNOWLEDGE_ENABLED=false` 显式关闭，关闭后该端点直接 503。
- 语料硬编码在 `policy-docs.ts`，没有做后台管理；换语料改这一个文件即可。
- 检索是内存余弦相似度，语料规模到千块以上时应换持久向量库（接口已对齐）。
