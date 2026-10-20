import {
  RequestIdLogger,
  currentRequestId,
  normalizeRequestId,
  runWithRequestId,
} from './request-context.js';

/**
 * 请求上下文的单测。
 *
 * 这里最值得钉的不是「happy path 能跑」，而是那个**白名单**：这个 id 会原样
 * 进日志和响应头，而它的来源是不可信的请求头。
 */
describe('请求上下文', () => {
  it('形状安全的 id 原样接受', () => {
    expect(normalizeRequestId('abc-123_DEF.456:789')).toBe(
      'abc-123_DEF.456:789',
    );
    // 网关常在两边加空白，去掉就好。
    expect(normalizeRequestId('  abc12345  ')).toBe('abc12345');
  });

  it('太短、太长、带换行的一律拒掉', () => {
    // 太短没有唯一性；太长会把每一行日志挤得没法读。
    expect(normalizeRequestId('short')).toBeNull();
    expect(normalizeRequestId('a'.repeat(65))).toBeNull();

    // 换行能在日志里伪造成一整行 —— 这正是白名单存在的理由。
    expect(
      normalizeRequestId('abc12345\n收到退出信号，数据库连接已释放'),
    ).toBeNull();
    // 重复的请求头会以数组形式出现，不是我们认识的形状。
    expect(normalizeRequestId(['abc12345', 'other12345'])).toBeNull();
    expect(normalizeRequestId(undefined)).toBeNull();
  });

  it('只有处在请求上下文里时，日志才带 id', () => {
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });

    try {
      const logger = new RequestIdLogger();

      logger.log('没有请求上下文', 'Ctx');
      runWithRequestId('req-12345678', () => {
        logger.log('在请求里', 'Ctx');
        // 嵌套的异步调用也看得到 —— 这是 ALS 的全部意义：
        // service 里那些 `await` 之后才发生的日志，不该丢掉 id。
        expect(currentRequestId()).toBe('req-12345678');
      });

      expect(lines[0]).toContain('没有请求上下文');
      expect(lines[0]).not.toContain('[req ');
      expect(lines[1]).toContain('[req req-12345678] 在请求里');
      // 出了上下文就该干净 —— 否则一个 id 会粘住后面的所有日志。
      expect(currentRequestId()).toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });

  it('非字符串的消息保持原样（不能把 Error 的堆栈打印弄坏）', () => {
    const lines: string[] = [];
    // `error` 走 stderr，`log` 走 stdout —— Nest 的 ConsoleLogger 就是这么分的。
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });

    try {
      const logger = new RequestIdLogger();
      const error = new Error('boom');

      runWithRequestId('req-abcdefgh', () => {
        logger.error(error, undefined, 'Ctx');
      });

      expect(lines.join('')).toContain('boom');
      // 对象/错误不加前缀：改了它的形状，Nest 的堆栈输出和其它工具就可能认不出来。
      expect(lines.join('')).not.toContain('[req req-abcdefgh]');
    } finally {
      write.mockRestore();
    }
  });
});
