import { describe, expect, it } from 'vitest';
import { Document } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';
import { InMemoryVectorStore } from './memory-vector-store.js';

/**
 * 内存向量库的单测。
 *
 * 全程用脚本化的假 embedding（按文本查表返回手工向量），不碰真模型 ——
 * 要测的是库的检索语义（排序、截断、归一化、接口契约），不是模型的语义质量。
 *
 * 其中「未归一化向量」这一组最关键：库的注释宣称余弦相似度 = 点积，
 * 依据是「入库向量已归一化」。这个前提在 LocalEmbeddings 里由模型层保证，
 * 但库自己不设防的话，换个没归一化的 embedding 实现（或直灌 addVectors），
 * 分数就会悄悄错掉 —— 这种错在真模型上几乎看不出来（0.73 变 0.81 而已），
 * 只有用构造出来的向量才能测到。
 */

/** 查表式假 embedding：词在表里就返回对应向量（可以是任意长度，不归一化） */
class TableEmbeddings extends Embeddings {
  private readonly table: Record<string, number[]>;

  constructor(table: Record<string, number[]>) {
    super({});
    this.table = table;
  }

  private lookup(text: string): number[] {
    for (const [key, vector] of Object.entries(this.table)) {
      if (text.includes(key)) return vector;
    }
    throw new Error(`假 embedding 查表落空：${text.slice(0, 40)}`);
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.lookup(t)));
  }

  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.lookup(text));
  }
}

const doc = (text: string) => new Document({ pageContent: text, metadata: { source: text } });

describe('InMemoryVectorStore', () => {
  it('addDocuments 按顺序调用 embedDocuments，检索返回对应文档', async () => {
    const store = new InMemoryVectorStore(
      new TableEmbeddings({ 猫: [1, 0], 狗: [0, 1] }),
    );
    await store.addDocuments([doc('猫'), doc('狗')]);

    const hits = await store.similaritySearchVectorWithScore([1, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0][0].pageContent).toBe('猫');
    expect(hits[0][1]).toBeCloseTo(1, 6); // 自己和自己的余弦相似度是 1
    expect(hits[1][0].pageContent).toBe('狗');
    expect(hits[1][1]).toBeCloseTo(0, 6); // 正交向量相似度是 0
  });

  it('排序按相似度降序，k 截断取前 k 个', async () => {
    // 三个方向各异的向量：query 更接近 A
    const store = new InMemoryVectorStore(new TableEmbeddings({}));
    await store.addVectors(
      [
        [1, 0.1],
        [0.9, 0.5],
        [0, 1],
      ],
      [doc('A'), doc('B'), doc('C')],
    );

    const top1 = await store.similaritySearchVectorWithScore([1, 0.2], 1);
    expect(top1).toHaveLength(1);
    expect(top1[0][0].pageContent).toBe('A');

    const top3 = await store.similaritySearchVectorWithScore([1, 0.2], 3);
    expect(top3.map(([d]) => d.pageContent)).toEqual(['A', 'B', 'C']);
  });

  it('k 大于库存量时返回全部，不报错；空库返回空数组', async () => {
    const store = new InMemoryVectorStore(new TableEmbeddings({}));
    await store.addVectors([[1, 0]], [doc('唯一')]);

    const hits = await store.similaritySearchVectorWithScore([1, 0], 10);
    expect(hits).toHaveLength(1);

    const empty = new InMemoryVectorStore(new TableEmbeddings({}));
    await expect(empty.similaritySearchVectorWithScore([1, 0], 3)).resolves.toEqual([]);
  });

  it('入库向量未归一化时，分数仍是余弦相似度（不依赖调用方归一化）', async () => {
    // 同方向但模长悬殊的两条向量，检索向量的模长也不同。
    // 若库不归一化，点积会被模长污染：[3,0] 和 [1,0] 的点积是 3，
    // 「自己和自己相似度 3」显然不是余弦。
    const store = new InMemoryVectorStore(new TableEmbeddings({}));
    await store.addVectors([[3, 0], [0, 0.5]], [doc('长向量'), doc('短向量')]);

    const hits = await store.similaritySearchVectorWithScore([10, 0], 2);
    expect(hits[0][0].pageContent).toBe('长向量');
    expect(hits[0][1]).toBeCloseTo(1, 6);
    expect(hits[1][1]).toBeCloseTo(0, 6);
  });

  it('反方向向量得到负相似度，排在最后', async () => {
    const store = new InMemoryVectorStore(new TableEmbeddings({}));
    await store.addVectors([[1, 0], [-1, 0]], [doc('同向'), doc('反向')]);

    const hits = await store.similaritySearchVectorWithScore([1, 0], 2);
    expect(hits[0][0].pageContent).toBe('同向');
    expect(hits[0][1]).toBeCloseTo(1, 6);
    expect(hits[1][1]).toBeCloseTo(-1, 6);
  });

  it('零向量归一化后保持原样，不产生 NaN', async () => {
    const store = new InMemoryVectorStore(new TableEmbeddings({}));
    await store.addVectors([[0, 0]], [doc('零向量')]);

    const hits = await store.similaritySearchVectorWithScore([1, 1], 1);
    expect(hits).toHaveLength(1);
    expect(Number.isNaN(hits[0][1])).toBe(false);
  });

  it('addVectors 的向量数与文档数不一致时直接抛错', async () => {
    const store = new InMemoryVectorStore(new TableEmbeddings({}));
    await expect(store.addVectors([[1, 0]], [])).rejects.toThrow('不一致');
  });

  it('实现 VectorStore 完整接口：asRetriever 可用，走 embedQuery 检索', async () => {
    const store = new InMemoryVectorStore(
      new TableEmbeddings({ 报销: [1, 0], 年假: [0, 1] }),
    );
    await store.addDocuments([doc('报销制度'), doc('年假制度')]);

    const retriever = store.asRetriever();
    const results = await retriever.invoke('报销流程是什么');
    expect(results).toHaveLength(2);
    expect(results[0].pageContent).toBe('报销制度');
  });
});
