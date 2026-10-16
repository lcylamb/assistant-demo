import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * 标 @Global 之后其他模块不用逐个 import 就能注入 PrismaService ——
 * 数据访问层每个业务模块都要用，逐个 import 纯属噪音。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
