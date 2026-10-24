import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './rag.service.js';

/**
 * 知识库问答模块（RAG + LangGraph）。
 *
 * 刻意**不**复用 LlmModule 的 LlmProvider 接口：那层接口只为
 * complete/stream 两个原语设计，而这条链路要的是 LangChain 的
 * 模型抽象（和向量库、图共用同一套 Runnable 体系）。两个模块
 * 各用各的模型接入方式，本身就是「两条路线」的对照样本。
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
