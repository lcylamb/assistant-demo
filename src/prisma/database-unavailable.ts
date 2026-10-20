import { Prisma } from '../generated/prisma/client.js';

/**
 * 哪些数据库错误算「库暂时不可用」，而不是「代码有 bug」。
 *
 * ── 为什么要分这一刀 ──
 *
 * 这两类错误对调用方的含义完全不同，但对上层接口来说，默认都长成 500：
 *
 *   · 代码 bug —— 修代码才能好，客户端重试多少次都一样；
 *   · 库连不上 —— 等一会儿或者换一个实例就好，重试是有意义的。
 *
 * 不区分的话，运维看到 500 会去翻请求处理逻辑（方向错了），
 * 客户端也不会重试一个其实能自愈的失败。所以这一类单独映射成 503。
 *
 * ── 为什么是白名单，不是「所有 Prisma 错误」──
 *
 * `PrismaClientKnownRequestError` 里还有 P2002（唯一键冲突）、P2025（记录不存在）
 * 这类**业务**错误 —— 它们不是基础设施故障，映射成 503 会把真正的 bug 藏进
 * 「服务暂时不可用」后面。所以只认**连接层面**的码，其余照旧往上抛。
 *
 * 这份清单对应 Prisma 文档里 P1xxx（连接与鉴权）+ P2024（连接池超时）：
 *   P1000 鉴权失败 / P1001 连不上 / P1002 连接超时 / P1008 操作超时
 *   P1010 无访问权限 / P1011 TLS 失败 / P1017 服务端关闭了连接 / P2024 连接池耗尽
 *
 * `PrismaClientInitializationError` 也归进来：客户端根本没初始化成功，
 * 后续每一条查询都会以同样的方式失败。
 *
 * ⚠️ 这是白名单，漏掉的错误会按原来的方式处理（500 / 工具降级），
 * 不会因为「没识别出来」而被误报成 503 —— 宁可少报，不要错报。
 */
const UNAVAILABLE_CODES = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1008',
  'P1010',
  'P1011',
  'P1017',
  'P2024',
]);

export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;

  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    UNAVAILABLE_CODES.has(error.code)
  );
}
