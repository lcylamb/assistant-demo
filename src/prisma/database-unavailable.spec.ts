import { Prisma } from '../generated/prisma/client.js';
import { isDatabaseUnavailable } from './database-unavailable.js';

/**
 * 这个分类器的全部价值在于**边界**：宽了会把业务错误藏成 503，窄了
 * 会让真正的库故障继续冒充 500。所以两边都要有用例钉住，不能只测「P1001 能认出来」。
 */
describe('isDatabaseUnavailable', () => {
  function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('boom', {
      code,
      clientVersion: '7.10.1',
    });
  }

  it.each([
    'P1000', // 鉴权失败
    'P1001', // 连不上
    'P1002', // 连接超时
    'P1008', // 操作超时
    'P1010', // 无访问权限
    'P1011', // TLS 失败
    'P1017', // 服务端关闭了连接
    'P2024', // 连接池耗尽
  ])('%s 算库不可用', (code) => {
    expect(isDatabaseUnavailable(prismaError(code))).toBe(true);
  });

  it.each([
    'P2002', // 唯一键冲突
    'P2025', // 记录不存在
    'P1012', // schema 校验失败（是配置/代码问题，不是「等会儿就好」）
  ])('%s 不算库不可用', (code) => {
    expect(isDatabaseUnavailable(prismaError(code))).toBe(false);
  });

  it('Prisma 客户端没初始化成功也算', () => {
    expect(
      isDatabaseUnavailable(
        new Prisma.PrismaClientInitializationError('boom', '7.10.1'),
      ),
    ).toBe(true);
  });

  it('不认识的抛出值一律不算 —— 宁可少报，不要错报', () => {
    expect(isDatabaseUnavailable(new Error('连不上数据库'))).toBe(false);
    expect(isDatabaseUnavailable('P1001')).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
  });
});
