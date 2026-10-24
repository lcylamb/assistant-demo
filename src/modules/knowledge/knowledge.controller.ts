import { Body, Controller, Get, Post } from '@nestjs/common';
import { KnowledgeAskDto } from './knowledge.dto.js';
import { KnowledgeService, type KnowledgeAnswer } from './rag.service.js';

/**
 * 制度知识库问答的 HTTP 面。
 *
 * 故意不做流式：RAG 的价值在「答得对、有出处」，sources 要等检索和
 * 引用校验都结束才有意义，逐字流一个还没经过校验的中间结果出去，
 * 和 assistant 模块流式结论的语义完全不同 —— 那边流的是同一个
 * settle 收口的结论前缀，这边流了就是假承诺。
 */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  info(): { module: string; sections: number; usage: string } {
    return {
      module: 'knowledge',
      sections: 10,
      usage: 'POST /knowledge/ask {"question": "招待费的上限是多少"}',
    };
  }

  @Post('ask')
  ask(@Body() dto: KnowledgeAskDto): Promise<KnowledgeAnswer> {
    return this.knowledge.ask(dto.question);
  }
}
