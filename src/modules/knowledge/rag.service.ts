/**
 * 制度知识库问答（RAG）。
 *
 * 和 assistant 模块的分工：那边是「结构化数据 → LLM」（单据字段直接进
 * prompt，考的是约束与流式）；这边是「非结构化文档 → LLM」——制度手册
 * 被切分成块、本地 embedding 进向量库，按问题检索出最相关的几块再回答。
 * 两条链路合起来才是 LLM 应用在业务里的完整形态：查数据 + 查规则。
 *
 * 图的结构（LangGraph）：
 *
 *   START → retrieve → grade ─┬─(相关)──────────────→ generate → END
 *                             └─(不相关且未改写过)→ rewrite → retrieve（重查一轮）
 *
 * 为什么需要 grade 节点而不是检索完直接答：向量检索只保证「语义相近」，
 * 不保证「包含答案」。问题措辞和制度用语对不上时（比如问「请客户吃饭
 * 能报多少」而手册写的是「业务招待费」），第一轮检索会落空 —— 这时
 * rewrite 把口语改写成制度用语再查一轮，是 RAG 系统里最常见也最有效
 * 的自愈手段。重试只允许一次（rewritten 标志位封口），防止图里长出循环。
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Document } from '@langchain/core/documents';
import { ChatOpenAI } from '@langchain/openai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { POLICY_SECTIONS } from './policy-docs.js';
import { LocalEmbeddings } from './local-embeddings.js';
import { InMemoryVectorStore } from './memory-vector-store.js';

export interface KnowledgeSource {
  /** 章节号 + 标题，如「3 餐饮招待」 */
  source: string;
  /** 余弦相似度，入库向量已归一化，取值 0~1 */
  score: number;
}

export interface KnowledgeAnswer {
  answer: string;
  sources: KnowledgeSource[];
  /** 是否触发了改写重查 —— 面试演示时这就是图的分支被走到的证据 */
  queryRewritten: boolean;
}

/** 每个知识块在向量库 metadata 里的形状 */
interface ChunkMeta {
  source: string;
}

const GraphState = Annotation.Root({
  question: Annotation<string>,
  /** 是否已经改写重查过 —— 图的循环由此封口 */
  rewritten: Annotation<boolean>,
  /** grade 的判定：检索到的块里有没有能回答问题的信息 */
  relevant: Annotation<boolean>,
  docs: Annotation<Document<Record<string, unknown>>[]>,
  sources: Annotation<KnowledgeSource[]>,
  answer: Annotation<string>,
  /** 生成阶段失败的原因。非空时 ask() 把它变成 503，图照常走到 END */
  failure: Annotation<string>,
});

const GRADE_PROMPT = `你是一个检索质量判定器。用户的问题是：

<question>{question}</question>

从制度手册中检索到以下知识块：

<chunks>
{chunks}
</chunks>

判断：这些知识块里是否包含回答该问题所需的信息？
只输出一个 JSON 对象，格式：{"relevant": true} 或 {"relevant": false}。不要输出其他内容。`;

const REWRITE_PROMPT = `把下面这个口语化的问题改写成适合在规章制度文档里检索的查询。
保留原意，使用制度文档的规范用语（例如「请客户吃饭能报多少」应改写为「业务招待费报销标准」）。

问题：{question}

只输出一个 JSON 对象，格式：{"query": "改写后的查询"}。不要输出其他内容。`;

const GENERATE_PROMPT = `你是报销制度问答助手。只依据下面给出的制度手册知识块回答问题。

<chunks>
{chunks}
</chunks>

规则：
1. 答案只使用知识块里的事实，数字必须与原文一致。知识块不足以回答问题时，在答案里说明制度中未覆盖该问题，不要编造。
2. citations 里列出答案依据的章节（格式如「3 餐饮招待」），必须来自知识块的章节，不要发明。
3. 用中文回答，简洁直接。

用户问题：{question}

只输出一个 JSON 对象，格式：{"answer": "回答", "citations": ["引用的章节"]}。不要输出其他内容。`;

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private store!: InMemoryVectorStore;
  /** 编译后的图只需要 invoke 这一个方法，用结构化类型避开泛型的循环推断 */
  private graph: {
    invoke(state: Partial<typeof GraphState.State>): Promise<typeof GraphState.State>;
  } | null = null;
  private chatModel: ChatOpenAI | null = null;
  /** 知识库是否已建好。懒加载：第一次 ask 才切分 + embedding（见 buildStore 的注释） */
  private ready = false;

  constructor(private readonly config: ConfigService) {}

  /**
   * 知识库是否启用。默认开（本地开发零配置）；Render 这类小内存部署实例
   * 上设 KNOWLEDGE_ENABLED=false 显式关掉 —— 本地模型加载后 RSS 实测 714MB，
   * 免费实例 512MB 装不下，eager 加载会让服务崩在启动阶段。
   */
  private get enabled(): boolean {
    return this.config.get<string>('KNOWLEDGE_ENABLED') !== 'false';
  }

  /**
   * 懒加载建库：切分 → embedding → 入库。纯本地操作，不需要 LLM key。
   * 放在首次 ask 而不是 onModuleInit 的原因有两个：
   * 1. 启动时间：模型加载 + 全量 embedding 要几秒，不该摊在每次部署重启上；
   * 2. 内存：embedding 模型加载后 RSS 约 714MB（实测），512MB 的免费部署
   *    实例根本装不下 —— 懒加载至少保证「不调用就不占内存」，配合
   *    KNOWLEDGE_ENABLED=false 让小内存实例安全跳过整个模块。
   */
  private async buildStore(): Promise<void> {
    const started = Date.now();
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 300,
      chunkOverlap: 40,
    });

    const docs = POLICY_SECTIONS.map(
      (section) =>
        new Document({
          pageContent: `【${section.title}】${section.text}`,
          metadata: { source: section.id } satisfies ChunkMeta,
        }),
    );

    const chunks = await splitter.splitDocuments(docs);
    this.store = new InMemoryVectorStore(new LocalEmbeddings());
    await this.store.addDocuments(chunks);
    this.ready = true;
    this.logger.log(
      `知识库就绪：${POLICY_SECTIONS.length} 个章节 → ${chunks.length} 个知识块（${Date.now() - started}ms）`,
    );
  }

  async ask(question: string): Promise<KnowledgeAnswer> {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        '知识库问答未启用（KNOWLEDGE_ENABLED=false）：该部署实例内存不足以运行本地 embedding 模型',
      );
    }
    if (!this.ready) await this.buildStore();
    const graph = await this.getGraph();
    const result = await graph.invoke({
      question,
      rewritten: false,
      relevant: false,
      docs: [],
      sources: [],
      answer: '',
      failure: '',
    });

    if (result.failure || !result.answer) {
      throw new ServiceUnavailableException(result.failure || '知识库问答失败，请重试');
    }
    return {
      answer: result.answer,
      sources: result.sources,
      queryRewritten: result.rewritten,
    };
  }

  // ---- 图的四个节点 ----

  private async retrieve(state: typeof GraphState.State) {
    // k=4：手册只有十几个块，取 4 个已覆盖大部分相关内容，也压得住 prompt 长度
    const hits = await this.store.similaritySearchWithScore(state.question, 4);
    const docs = hits.map(([doc]) => doc);
    const sources = hits.map(([doc, score]) => ({
      source: chunkSource(doc),
      score: Number(score.toFixed(3)),
    }));
    return { docs, sources };
  }

  private async gradeDocs(state: typeof GraphState.State) {
    const model = this.getModel();
    const raw = await model.invoke(
      GRADE_PROMPT.replace('{question}', state.question).replace('{chunks}', formatChunks(state.docs)),
    );
    const parsed = extractJson<{ relevant: boolean }>(text(raw));
    this.logger.log(`检索质量判定：${parsed?.relevant ?? '解析失败（按不相关处理）'}`);
    return { relevant: parsed?.relevant === true };
  }

  private async rewriteQuery(state: typeof GraphState.State) {
    const model = this.getModel();
    const raw = await model.invoke(REWRITE_PROMPT.replace('{question}', state.question));
    const parsed = extractJson<{ query: string }>(text(raw));
    const rewritten = parsed?.query?.trim();
    if (!rewritten) {
      // 改写失败不阻塞主流程：rewritten 置真让图往下走 generate，
      // 原问题检索不到答案时，generate 会按规则回答「制度中未覆盖」
      this.logger.warn('查询改写失败，直接用原问题生成');
      return { rewritten: true };
    }
    this.logger.log(`查询改写：「${state.question}」→「${rewritten}」`);
    return { question: rewritten, rewritten: true };
  }

  private async generate(state: typeof GraphState.State) {
    const model = this.getModel();
    const raw = await model.invoke(
      GENERATE_PROMPT.replace('{question}', state.question).replace('{chunks}', formatChunks(state.docs)),
    );
    const parsed = extractJson<{ answer: string; citations: string[] }>(text(raw));
    if (!parsed?.answer) {
      return { failure: '模型回答格式异常，请重试' };
    }

    // 防幻觉收口，思路同 assistant 模块的 dropUnknownEvidence：
    // sources 只保留答案真正引用的章节（带着检索分数），模型编出来的引用自然进不来。
    const bySource = new Map(state.sources.map((s) => [s.source, s]));
    const sources = (parsed.citations ?? [])
      .map((c) => bySource.get(c))
      .filter((s): s is KnowledgeSource => s !== undefined);

    return { answer: parsed.answer, sources };
  }

  // ---- 图的组装与模型 ----

  private async getGraph() {
    if (this.graph) return this.graph;

    const workflow = new StateGraph(GraphState)
      .addNode('retrieve', (s: typeof GraphState.State) => this.retrieve(s))
      .addNode('grade', (s: typeof GraphState.State) => this.gradeDocs(s))
      .addNode('rewrite', (s: typeof GraphState.State) => this.rewriteQuery(s))
      .addNode('generate', (s: typeof GraphState.State) => this.generate(s))
      .addEdge(START, 'retrieve')
      .addEdge('retrieve', 'grade')
      .addEdge('rewrite', 'retrieve')
      .addConditionalEdges('grade', (s: typeof GraphState.State) =>
        s.relevant || s.rewritten ? 'generate' : 'rewrite',
      )
      .addEdge('generate', END);

    const compiled = workflow.compile();
    this.graph = compiled;
    return compiled;
  }

  private getModel(): ChatOpenAI {
    if (!this.chatModel) {
      const apiKey = this.config.get<string>('LLM_API_KEY');
      if (!apiKey) {
        throw new ServiceUnavailableException(
          '未配置 LLM_API_KEY：知识库问答需要真实模型，见 .env.example 的说明',
        );
      }
      this.chatModel = new ChatOpenAI({
        model: this.config.get<string>('LLM_MODEL') ?? 'deepseek-chat',
        temperature: 0,
        configuration: {
          baseURL: this.config.get<string>('LLM_BASE_URL') ?? 'https://api.deepseek.com/v1',
          apiKey,
        },
      });
    }
    return this.chatModel;
  }
}

function text(response: { content: unknown }): string {
  return typeof response.content === 'string' ? response.content : '';
}

/** Document.metadata 在类型上是 Record<string, unknown>，入库时我们写入的是 ChunkMeta */
function chunkSource(doc: Document<Record<string, unknown>>): string {
  return (doc.metadata as unknown as ChunkMeta).source;
}

function formatChunks(docs: Document<Record<string, unknown>>[]): string {
  return docs
    .map((d, i) => `[${i + 1}] ${chunkSource(d)}\n${d.pageContent}`)
    .join('\n\n');
}

/** 从模型输出里抠出第一个 JSON 对象；模型偶尔套 Markdown 代码块，这里容错 */
function extractJson<T>(input: string): T | null {
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(input.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
