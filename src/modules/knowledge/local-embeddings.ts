/**
 * 本地 embedding，实现 LangChain 的 Embeddings 接口。
 *
 * 为什么不用 OpenAI/DeepSeek 的 embedding API：DeepSeek 根本不提供
 * embeddings 端点；换一家供应商意味着多一把 key、多一个计费方。而这个
 * 模块的知识库只有十几个章节，本地模型（~90MB，首次运行下载后常驻缓存）
 * 在这个量级上质量和延迟都完全够用 —— 这也是 WebPilot 的任务记忆用的
 * 同一个模型，两个项目共享同一条技术判断。
 *
 * 模型是 sentence-transformers 的多语言 MiniLM：384 维，中文效果在
 * 同尺寸里最好的一档。池化用 mean + L2 归一化，归一化之后余弦相似度
 * 退化为点积，检索实现可以少一次除法。
 */

import { Embeddings } from '@langchain/core/embeddings';

/** 模型输出维度 —— 换模型时这里和向量库一起改 */
export const EMBEDDING_DIM = 384;

export class LocalEmbeddings extends Embeddings {
  /** pipeline 加载要几秒，惰性单例：第一个请求承担，之后复用 */
  private static extractor: Promise<
    (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>
  > | null = null;

  private readonly modelName: string;

  constructor(modelName?: string) {
    super({});
    this.modelName =
      modelName ??
      process.env.EMBEDDING_MODEL ??
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  }

  private async getExtractor() {
    if (!LocalEmbeddings.extractor) {
      // 延迟 import：transformers.js 初始化会读环境变量（如 HF 镜像），
      // 放在函数体里保证读到的是运行时环境，而不是模块加载时的。
      const { pipeline, env } = await import('@huggingface/transformers');
      // 国内网络直连 huggingface.co 常年超时，配了镜像就走镜像
      if (process.env.HF_MIRROR) env.remoteHost = process.env.HF_MIRROR;
      LocalEmbeddings.extractor = pipeline('feature-extraction', this.modelName, {
        dtype: 'q8',
      }) as never;
    }
    return LocalEmbeddings.extractor;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }

  embedDocuments(documents: string[]): Promise<number[][]> {
    return this.embed(documents);
  }

  embedQuery(document: string): Promise<number[]> {
    return this.embed([document]).then((v) => v[0]);
  }
}
