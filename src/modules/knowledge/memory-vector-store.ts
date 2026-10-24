/**
 * 内存向量库，实现 LangChain 的 VectorStore 接口。
 *
 * 为什么自己写而不用现成的：@langchain/community 在 v1 里把
 * MemoryVectorStore 砍掉了（社区包大幅瘦身），而本项目已有 PostgreSQL，
 * pgvector 又是另一套扩展和迁移工序。对一个十几个章节的知识库来说，
 * 按 VectorStore 接口实现一个内存版是最诚实的中间态 ——
 * 接口是对的（VectorStoreRetriever、asRetriever 全部可用），存储是临时的。
 *
 * 什么时候该换：文档量上千、需要跨进程共享、或服务多实例部署时，
 * 换 pgvector —— 只动这个文件，RAG 链和图一行不改。这正是接口存在的意义。
 */

import { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';

interface StoredVector {
  document: Document;
  vector: number[];
}

export class InMemoryVectorStore extends VectorStore {
  private vectors: StoredVector[] = [];

  _vectorstoreType(): string {
    return 'in-memory';
  }

  constructor(embeddings: EmbeddingsInterface) {
    super(embeddings, {});
  }

  /** VectorStore 的抽象方法：文本 → embedding → 入库 */
  async addDocuments(documents: Document[]): Promise<void> {
    const texts = documents.map((d) => d.pageContent);
    const embeddings = await this.embeddings.embedDocuments(texts);
    // zip：embedding 顺序和输入顺序一致，这是 embedDocuments 的契约
    this.vectors = documents.map((document, i) => ({
      document,
      vector: embeddings[i],
    }));
  }

  async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
    if (vectors.length !== documents.length) {
      throw new Error(`向量数 ${vectors.length} 与文档数 ${documents.length} 不一致`);
    }
    this.vectors = vectors.map((vector, i) => ({ document: documents[i], vector }));
  }

  /**
   * 基类约定的检索原语：给查询向量和 k，返回 [Document, 相似度] 列表。
   * 向量在入库时已 L2 归一化，余弦相似度 = 点积。
   * filter 参数是基类签名的一部分（本实现用不上，接收但忽略）。
   */
  async similaritySearchVectorWithScore(
    vector: number[],
    k: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    filter?: this['FilterType'],
  ): Promise<[Document, number][]> {
    const scored = this.vectors
      .map((s) => ({ ...s, score: dotProduct(vector, s.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return scored.map((s) => [s.document, s.score] as [Document, number]);
  }
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
