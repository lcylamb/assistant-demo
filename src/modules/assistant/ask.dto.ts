import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * 入参校验。
 *
 * 为什么用 class 而不是 interface：`interface` 只活在编译期，编译完就没了，
 * 运行时一个字段都校验不了。class 会被 `ValidationPipe` 实例化成对象，
 * 装饰器写的规则才真的会执行 —— 这是 TS 项目里最容易漏掉的一环。
 */
export class AskDto {
  /**
   * 报销单号。格式约束得这么死是有意的：
   * 它会被拼进 SQL 查询条件，也会出现在日志里，让它只可能是这个形状，
   * 就不必再为「用户传了什么奇怪的东西」写防御代码。
   */
  @IsString()
  @Matches(/^BX-\d{4}-\d{4}$/, { message: '单号格式应为 BX-2026-0003' })
  code!: string;

  @IsString()
  @MinLength(2, { message: '问题太短了' })
  @MaxLength(200, { message: '问题不要超过 200 字' })
  question!: string;

  /**
   * 之前的问答。**由客户端回传**，服务端不存会话（见 assistant.service.ts 的
   * buildMessages 那段注释）。
   *
   * 三个上限不是随手写的：这是唯一一条**客户端能往 prompt 里塞内容**的路径，
   * 所以它的形状必须被钉死 —— 3 轮、每轮结论 500 字、16 个字段路径。
   * 不设上限的话，这个字段就是一个「免费让模型读任意长文本」的入口，
   * 而额度是按**调用次数**算的，不按 token —— 等于给了一个绕过成本的洞。
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: '最多带 3 轮历史' })
  @ValidateNested({ each: true })
  @Type(() => HistoryTurnDto)
  history?: HistoryTurnDto[];
}

/**
 * 一轮历史的形状 = **上一轮的结构化结论**，不是模型原话。
 *
 * 这个选择是「上下文管理」的核心：把整段对话文本堆回去有两个问题 ——
 * 一是 token 随轮数线性涨，二是那些文本里混着模型可能没被校验过的中间产物。
 * 这里只回传 `AskResult` 里被校验过的那三个模型字段，历史于是天然是干净的。
 */
export class HistoryTurnDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  question!: string;

  @IsString()
  @MaxLength(500, { message: '历史结论不要超过 500 字' })
  conclusion!: string;

  @IsArray()
  @ArrayMaxSize(16, { message: '历史依据最多 16 个字段' })
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  evidence!: string[];

  @IsBoolean()
  insufficient!: boolean;
}
