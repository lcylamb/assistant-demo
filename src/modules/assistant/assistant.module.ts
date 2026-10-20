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
})
export class AssistantModule {}
