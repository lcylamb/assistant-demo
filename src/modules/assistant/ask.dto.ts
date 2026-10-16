import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

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
}
