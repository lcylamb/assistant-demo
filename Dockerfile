# syntax=docker/dockerfile:1

# 五段：依赖 → 构建 → 生产依赖 → 迁移 → 运行时。
#
# 分这么多段的理由只有一条：**每一段产出的东西，生命周期和权限都不一样**。
#   · 构建需要编译器和全部 devDependencies，只在 CI 里活几十秒
#   · 迁移需要能改 schema 的权限，但一天只跑一次
#   · 运行时只需要 dist、生产依赖和一个只读的 public/，要跑几个月
# 把它们塞进同一个镜像，等于让长期运行的那个进程白白带着构建工具，
# 以及一份「能改 schema」的能力。
#
# ⚠️ 基础镜像固定到小版本，不用 `node:24-alpine` 这种飘动的 tag：
# 飘动的 tag 会让「昨天能构建，今天构建出别的东西」，而这类问题最难查。
#
# 版本要和 .nvmrc 一致：CI 用 .nvmrc 装 Node，这里用同一个小版本，
# 两边跑出来的才是一套东西。
ARG NODE_IMAGE=node:24.22.0-alpine

# ────────────────────────────────────────────────────────────
# 1. 依赖
# ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# 只拷这四个文件，是为了缓存：只要它们没变，改一行业务代码不会触发重新 npm ci。
# 顺序有讲究 —— 先依赖清单，再源码。
#
# .npmrc 必须带上：里面那句 legacy-peer-deps 是这套依赖能装上的前提（原因写在那个文件里）。
COPY package.json package-lock.json .npmrc ./

# npm ci 而不是 npm install：严格按 lockfile 装，构建可复现。
#
# --ignore-scripts 是刻意的：npm ci 默认会跑 postinstall（本项目挂的是 prisma generate），
# 但这一层里还没有 prisma/schema.prisma，跑了必然失败。构建阶段会显式跑 generate。
# 顺带的好处是镜像构建期间不执行依赖包自带的各种安装脚本 —— 那是最经典的一条供应链攻击面。
RUN npm ci --ignore-scripts

# ────────────────────────────────────────────────────────────
# 2. 构建
# ────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY nest-cli.json tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# generate 必须在 build **之前**，因为：
#   · Prisma 7 把 client 生成到 src/generated/prisma（见 schema.prisma 的注释），是 .ts 文件
#   · 它要被 `nest build`（tsc）一起编译进 dist
#   · 而 src/generated/ 在 .gitignore 里，镜像里这份只能现生成
#
# prisma.config.ts 求值时会立刻读 DATABASE_URL，缺了直接抛 PrismaConfigEnvError。
# 而 `prisma generate` 根本不连库 —— 它只读 schema 生成代码。
#
# ⚠️ 写成 `RUN DATABASE_URL=... npx ...` 而不是单独一行 `ENV DATABASE_URL=...`：
# ENV 会留在这个 stage 的镜像配置里，而 migrator 是从这一层继承出去的，
# 于是这个假连接串会一路跟着进迁移镜像 —— 哪天忘了传环境变量，
# 它不会报错，而是安静地去连一个 127.0.0.1 上的、装着假账号的库。
# 写在 RUN 前面只作用于这一条命令，之后就不存在了。
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npx prisma generate

RUN npm run build

# ────────────────────────────────────────────────────────────
# 3. 生产依赖
# ────────────────────────────────────────────────────────────
FROM deps AS prod-deps
# 从装好的那棵树里剪掉 devDependencies。
# 比再来一次 `npm ci --omit=dev` 快 —— 复用了上面那层的缓存。
RUN npm prune --omit=dev --ignore-scripts

# ────────────────────────────────────────────────────────────
# 4. 迁移（一次性，不是常驻服务）
# ────────────────────────────────────────────────────────────
FROM build AS migrator
# 这一层故意保留 devDependencies（prisma CLI 在里面）和 prisma/ 目录，
# 只为跑一条命令。**它不进最终镜像** —— runtime 那一层看不到这些。
CMD ["npx", "prisma", "migrate", "deploy"]

# ────────────────────────────────────────────────────────────
# 5. 运行时
# ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3100

# 只拷运行时真正需要的四样东西。
# 源码、devDependencies、tsconfig、prisma CLI 都不在这里 —— 这一步决定了镜像大小。
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# public/ 直接取自构建上下文，**不经 build 阶段**：
# 它是纯静态的，`nest build` 一个字都不改它。绕一趟 build 只会让
# 「改一行 HTML 要等整个编译链」—— 而且 build 那一层根本没 COPY 它。
COPY --chown=node:node public ./public

COPY --chown=node:node package.json ./

# 不以 root 跑。容器里的 root 就是宿主机的 root，这是最便宜的一道防线。
USER node

EXPOSE 3100

# 探活直接问应用自己的 /health，而不是只查端口通不通 ——
# 端口开着但数据库连不上时，后者会一直报健康。
# /health 内部会真的发一条 `select 1`（2s 上限，见 src/app.controller.ts），
# 所以这里的 3s 超时必须比它长，否则先到的永远是探针自己的超时。
#
# 用 node 自带的 fetch 而不是 curl：alpine 镜像里没有 curl，
# 为了一个探针去 apk add 一个包不划算；Node 22+ 有全局 fetch。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 exec 形式（数组）而不是 shell 形式：shell 形式会让 node 变成 shell 的子进程，
# 于是 SIGTERM 发给 shell，node 收不到 —— 优雅退出就永远不会触发。
CMD ["node", "dist/main.js"]
