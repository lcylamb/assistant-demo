import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';

@Module({
  imports: [LlmModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
