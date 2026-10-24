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
    await this.addVectors(embeddings, documents);
  }

  async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
    if (vectors.length !== documents.length) {
      throw new Error(`向量数 ${vectors.length} 与文档数 ${documents.length} 不一致`);
    }
    // 入库前统一 L2 归一化，余弦相似度 = 点积。不能假设 embedding 实现已经
    // 归一化过：LocalEmbeddings 在模型层开了 normalize，但这个库的契约不该
    // 依赖调用方的实现细节 —— 换 embedding（或未来迁 pgvector 前的直灌
    // addVectors 路径）时，忘掉归一化的表现是「分数悄悄不再是余弦」，排错
    // 成本远高于每次入库一次 O(n·d) 的除法。
    this.vectors = vectors.map((vector, i) => ({
      document: documents[i],
      vector: l2Normalize(vector),
    }));
  }

  /**
   * 基类约定的检索原语：给查询向量和 k，返回 [Document, 相似度] 列表。
   * 库内向量已归一化，查询向量在这里同样归一化后再算点积。
   * filter 参数是基类签名的一部分（本实现用不上，接收但忽略）。
   */
  async similaritySearchVectorWithScore(
    vector: number[],
    k: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    filter?: this['FilterType'],
  ): Promise<[Document, number][]> {
    const query = l2Normalize(vector);
    const scored = this.vectors
      .map((s) => ({ ...s, score: dotProduct(query, s.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return scored.map((s) => [s.document, s.score] as [Document, number]);
  }
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector.slice() : vector.map((v) => v / norm);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
