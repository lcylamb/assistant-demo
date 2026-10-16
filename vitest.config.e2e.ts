import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // vitest 默认会把 console 输出拦下来，只在用例**失败**时才放出来。
    // 对评测集来说这正好是反的：那张对/错表是**产物**，不是失败时才看的调试信息。
    // 全绿的时候看不到表，这个评测就等于没做。
    disableConsoleIntercept: true,
  },
});
