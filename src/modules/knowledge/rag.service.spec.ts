import { describe, expect, it } from 'vitest';
import { Document } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';
import { ServiceUnavailableException } from '@nestjs/common';
import { KnowledgeService } from './rag.service.js';
import { InMemoryVectorStore } from './memory-vector-store.js';

/**
 * RAG 图的单测。
 *
 * 图有四条路径（直答 / 改写重查后答 / 改写重查仍答不上 / 生成失败），
 * 在真模型上「这次走了哪条路」只能从 queryRewritten 一个布尔值倒推，
 * 改写分支触发条件写错（比如 rewritten 忘了封口）的表现只是「偶尔多查
 * 一轮」，几乎不可复现。所以这里塞一个**脚本化假模型**：它按预设的第 N 次
 * 调用返回 grade / rewrite / generate 的答案，并记下每次收到的 prompt ——
 * 「第二次 grade 收到的是改写后的问题」这种断言才写得出来。
 *
 * 向量库用真实现 + 查表假 embedding：检索语义由 memory-vector-store.spec.ts
 * 负责，这里只需要「检索结果确定可预期」，假表足够。
 */

// ─────────────────────────────────────────────────────────────
// 桩：embedding / 模型
// ─────────────────────────────────────────────────────────────

class TableEmbeddings extends Embeddings {
  constructor(private readonly table: Record<string, number[]>) {
    super({});
  }

  private lookup(text: string): number[] {
    for (const [key, vector] of Object.entries(this.table)) {
      if (text.includes(key)) return vector;
    }
    return [0, 0, 1];
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.lookup(t)));
  }

  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.lookup(text));
  }
}

interface ScriptedCall {
  prompt: string;
  reply: string;
}

/** 脚本化假模型：按序返回预设回复，记下每次收到的完整 prompt */
function scriptedModel(script: string[]) {
  const calls: ScriptedCall[] = [];
  return {
    calls,
    invoke(prompt: string) {
      const reply = script[calls.length] ?? '{"relevant": true}';
      calls.push({ prompt, reply });
      return Promise.resolve({ content: reply });
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 桩：向量库（真实现 + 假向量，metadata.source 与 prompt 格式对齐）
// ─────────────────────────────────────────────────────────────

async function fakeStore(): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore(new TableEmbeddings({ 招待: [1, 0, 0], 差旅: [0, 1, 0] }));
  await store.addDocuments([
    new Document({
      pageContent: '业务招待费人均不超过150元。',
      metadata: { source: '3 餐饮招待' },
    }),
    new Document({
      pageContent: '差旅费凭发票据实报销。',
      metadata: { source: '5 差旅' },
    }),
  ]);
  return store;
}

/** 绕过 onModuleInit（真模型太重）与 getModel（真 LLM key），直接注入桩 */
async function serviceWith(script: string[]) {
  const service = new KnowledgeService({ get: () => undefined } as never);
  (service as never as { store: InMemoryVectorStore }).store = await fakeStore();
  const model = scriptedModel(script);
  (service as never as { chatModel: unknown }).chatModel = model;
  return { service, model };
}

describe('KnowledgeService（RAG 图）', () => {
  it('检索相关：grade → generate 两步直答，sources 只保留真实引用的章节', async () => {
    const { service, model } = await serviceWith([
      '{"relevant": true}',
      '```json\n{"answer":"人均不超过150元","citations":["3 餐饮招待","9 编造章节"]}\n```',
    ]);

    const answer = await service.ask('招待费上限是多少');

    expect(answer.answer).toBe('人均不超过150元');
    expect(answer.queryRewritten).toBe(false);
    // 防幻觉收口：模型编造的「9 编造章节」必须被丢弃，留下的带着检索分数
    expect(answer.sources).toEqual([{ source: '3 餐饮招待', score: expect.any(Number) }]);
    expect(answer.sources[0].score).toBeGreaterThan(0.9);
    // 模型只被调用两次（grade + generate），没有多余的轮次
    expect(model.calls).toHaveLength(2);
    // generate 的 prompt 里带着问题与检索到的知识块
    expect(model.calls[1].prompt).toContain('招待费上限是多少');
    expect(model.calls[1].prompt).toContain('3 餐饮招待');
  });

  it('首轮检索落空：grade 判不相关 → rewrite 改写 → 重查 → 第二轮 grade 通过', async () => {
    const { service, model } = await serviceWith([
      '{"relevant": false}',
      '{"query": "业务招待费报销标准"}',
      '{"relevant": true}',
      '{"answer": "人均150元", "citations": ["3 餐饮招待"]}',
    ]);

    const answer = await service.ask('请客户吃饭能报多少');

    expect(answer.queryRewritten).toBe(true);
    // 调用序列必须是 grade → rewrite → grade → generate，恰好一轮改写
    expect(model.calls).toHaveLength(4);
    expect(model.calls[0].prompt).toContain('检索质量判定器');
    expect(model.calls[1].prompt).toContain('改写成');
    expect(model.calls[2].prompt).toContain('检索质量判定器');
    // 第二轮 grade 收到的必须是改写后的问题，不是原问题
    expect(model.calls[2].prompt).toContain('业务招待费报销标准');
    expect(model.calls[2].prompt).not.toContain('请客户吃饭能报多少');
  });

  it('改写重查仍不相关：rewritten 封口后直接 generate，诚实回答不编造', async () => {
    const { service, model } = await serviceWith([
      '{"relevant": false}',
      '{"query": "年假天数规定"}',
      '{"relevant": false}',
      '{"answer": "制度中未覆盖该问题", "citations": []}',
    ]);

    const answer = await service.ask('年假有几天');

    expect(answer.answer).toBe('制度中未覆盖该问题');
    expect(answer.sources).toEqual([]);
    expect(answer.queryRewritten).toBe(true);
    // 图到此为止：4 次调用，不能长出第三轮检索
    expect(model.calls).toHaveLength(4);
  });

  it('改写失败（输出不是合法 JSON）：不阻塞，带着原问题直接 generate', async () => {
    const { service, model } = await serviceWith([
      '{"relevant": false}',
      '我觉得应该改写成别的（没有 JSON）',
      '{"relevant": true}',
      '{"answer": "人均150元", "citations": ["3 餐饮招待"]}',
    ]);

    const answer = await service.ask('请客户吃饭能报多少');

    expect(answer.answer).toBe('人均150元');
    expect(answer.queryRewritten).toBe(true);
    // generate 的 prompt 里仍是原问题
    expect(model.calls[3].prompt).toContain('请客户吃饭能报多少');
  });

  it('grade 输出解析失败：按不相关处理，走改写分支', async () => {
    const { service, model } = await serviceWith([
      'relevant: true（模型没按格式来）',
      '{"query": "业务招待费报销标准"}',
      '{"relevant": true}',
      '{"answer": "人均150元", "citations": ["3 餐饮招待"]}',
    ]);

    const answer = await service.ask('招待费上限');
    expect(answer.queryRewritten).toBe(true);
    expect(model.calls[0].prompt).toContain('检索质量判定器');
  });

  it('generate 输出缺 answer：ask 抛 503，而不是把空答案当成功', async () => {
    const { service } = await serviceWith(['{"relevant": true}', '{"citations": []}']);

    await expect(service.ask('招待费上限')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('模型输出套着 Markdown 代码块也能解析（extractJson 容错）', async () => {
    const { service } = await serviceWith([
      '前缀噪声 {"relevant": true} 后缀噪声',
      '{"answer": "人均150元", "citations": ["3 餐饮招待"]}',
    ]);

    const answer = await service.ask('招待费上限');
    expect(answer.answer).toBe('人均150元');
  });
});
