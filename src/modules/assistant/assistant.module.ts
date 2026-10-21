import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { AssistantMetricsService } from './assistant-metrics.service.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { ModelConcurrencyGuard } from './model-concurrency.guard.js';

@Module({
  imports: [LlmModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantMetricsService, ModelConcurrencyGuard],
  // 全局限流守卫（AppModule 里的 APP_GUARD）也要往同一本账上记拒绝次数 ——
  // 不导出的话，它只能自己 new 一个计数，两边各算各的。
  exports: [AssistantMetricsService],
})
export class AssistantModule {}
