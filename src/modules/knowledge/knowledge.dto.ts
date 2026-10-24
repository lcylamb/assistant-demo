import { IsString, MaxLength, MinLength } from 'class-validator';

export class KnowledgeAskDto {
  @IsString()
  @MinLength(2, { message: '问题太短了，至少 2 个字符' })
  @MaxLength(200, { message: '问题最长 200 个字符' })
  question!: string;
}
