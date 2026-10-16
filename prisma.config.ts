// Prisma 7 的配置入口。
//
// ⚠️ 两处和 Prisma 5/6 的教程不一样，照老教程写会卡住：
//
//   1. **连接串不能写在 schema.prisma 里。** v7 起 `url = env(...)` 会直接报 P1012，
//      schema 里只留 `provider`。原因见下面注释。
//   2. **Prisma CLI 不再自动加载 .env。** v5/6 会自动读，v7 不会 —— 少了
//      `import 'dotenv/config'`，`env('DATABASE_URL')` 会抛
//      PrismaConfigEnvError: Cannot resolve environment variable。
//      注意：应用运行时是 @nestjs/config 在加载 .env，那是另一个进程，帮不上 CLI。
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * 为什么 v7 要把 url 挪出来？
 *
 * 因为 PrismaClient 不再自己管连接池了 —— 它改为接收一个 **driver adapter**
 * （见 src/prisma/prisma.service.ts 里的 `new PrismaPg(...)`）。
 * 连接池参数（max / 空闲回收 / 取连接超时）这些原本藏起来的东西，
 * 现在都归调用方显式决定。
 *
 * 代价是概念多了一层；好处是「连接池怎么配」从黑盒变成了能看懂、能调的代码。
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',

  datasource: {
    url: env('DATABASE_URL'),
  },

  migrations: {
    path: 'prisma/migrations',
    // 注册之后 `prisma db seed` 和 `prisma migrate reset` 会自动跑它。
    // 用 tsx 而不是 `node --experimental-strip-types`：后者要 Node 22.6+，
    // 本机是 Node 20，那个 flag 还不存在。
    seed: 'tsx prisma/seed.ts',
  },
});
