# 构建、部署与配置

## 容器

```bash
docker compose up --build   # 数据库 + 迁移 + 应用
docker compose down
```

启动顺序由 `depends_on` 保证：数据库健康 → `migrate` 执行完毕并以 0 退出 → `app` 启动。迁移使用 `service_completed_successfully` 而不是「启动了就算」，避免应用在建表完成之前开始接受请求。

构建分为五段：`deps → build → prod-deps → migrator → runtime`。分开的原因是各段产物的生命周期与权限不同：

- 构建需要编译器和全部开发依赖，只存活几十秒；
- 迁移需要修改 schema 的权限，一天执行一次；
- 运行时只需要 `dist`、生产依赖和只读的 `public/`，需要长时间运行。

产物大小：runtime 镜像约 372MB，migrator 镜像约 1.27GB（包含 Prisma CLI 与完整开发依赖，因此不作为常驻服务）。

镜像约束：

- **不包含密钥。** `.dockerignore` 排除 `.env`，Dockerfile 不使用 `COPY . .`，每个 `COPY` 都指定具体路径。构建期 `prisma generate` 需要的 `DATABASE_URL` 通过单条 `RUN` 命令传入，不使用 `ENV`，避免该值被后续镜像层继承。
- **以非 root 运行。** `USER node`。
- **`CMD` 使用 exec 形式。** shell 形式会让 node 成为 shell 的子进程，`SIGTERM` 无法直接到达 node，优雅退出不会触发。

## 启动与关闭

**启动时检查数据库。** `PrismaService.onModuleInit` 执行一次 `select 1`。使用 driver adapter 后 `$connect()` 是惰性的，数据库不可达也会「成功」，只有实际查询才能验证连接。检查失败时进程拒绝启动，并输出启动数据库与建表的命令。

代价是：数据库故障期间，平台会因为实例启动失败而反复重启，直到数据库恢复。这是有意选择的——无法读取数据的实例没有价值，反复重启至少让故障可见。

**关闭不等待活跃连接。** 应用启用 `forceCloseConnections`，关闭时直接销毁 socket：

- 默认的 `server.close()` 会等待所有活跃请求结束；一次 SSE 回答最坏可能运行数分钟，而容器平台的宽限期通常只有 10 秒，超时后 `SIGKILL`（退出码 137）。
- 启用后关闭在毫秒级完成，销毁钩子（数据库 `$disconnect`）仍会先执行。
- 代价是在途的普通请求也会被切断。更细的做法是「停止接受新连接 → 限时窗口 → 到点强制断开」，此处未实现。

**探活。** `/health` 执行一次 `select 1`（2 秒上限）。端口可连接但数据库不可达时返回 `503` + `{"status":"error","db":"down"}`。

## 部署

部署目标为 Render + Neon：Render 使用仓库中的 `Dockerfile` 构建，Neon 提供托管 PostgreSQL。

托管平台不执行仓库内的迁移。迁移需要从本机对生产数据库手动执行一次；修改 schema 后需要重新执行。演示环境的迁移是一次性的，因此没有引入付费的 pre-deploy 步骤，也没有让 runtime 镜像携带 Prisma CLI（那会抵消分层带来的收益）。

需要配置的环境变量：

- `DATABASE_URL`（Neon 连接串）
- `LLM_PROVIDER=openai`
- `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`
- `LLM_DAILY_LIMIT`（公网部署建议设置）
- `TRUST_PROXY=1`（Render 位于反向代理之后）

密钥只应出现在本地 `.env` 与部署平台的 secret 中。源码、`.env.example` 和镜像中都不包含密钥；错误处理只读取厂商响应体，不回显请求头。

## 持续集成

每次 push / PR 执行：

1. `lint`（oxlint，含类型检查）
2. `tsc --noEmit`
3. `build`
4. 单元测试
5. 端到端测试（含 23 条评测）

数据库由 GitHub Actions 的 service 容器提供，每次从零执行 `migrate deploy` 与 seed。评测中的期望值大多从数据计算得出，流水线与本机必须使用同一份数据，否则对错表没有意义。

流水线末尾验证容器产物：

- `docker build --target runtime`，启动真实容器连接真实数据库；
- 请求 `/health` 与一次 `/assistant/ask`；
- 确认镜像中没有 `.env`、进程不是 root；
- 带一条正在写入的流执行 `docker stop`，断言退出码为 0 且用时小于 5 秒。

CI 只运行 mock。真实模型评测在本地手动执行：其输出随模型变化，放入 CI 会让失败难以归因。CI 验证管道是否完整，真实模型评测验证回答质量。

## 环境变量

完整说明见 [`.env.example`](../.env.example)。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL 连接串 |
| `PORT` | `3100` | 监听端口 |
| `LLM_PROVIDER` | `mock` | `mock`（规则表）或 `openai`（OpenAI 兼容协议） |
| `LLM_API_KEY` | — | `openai` 模式必填 |
| `LLM_BASE_URL` | — | `openai` 模式必填，例如 `https://api.deepseek.com/v1` |
| `LLM_MODEL` | — | `openai` 模式必填 |
| `LLM_TIMEOUT_MS` | `30000` | 单轮调用上限；流式下约束首字等待与帧间沉默 |
| `LLM_MAX_TOKENS` | `1024` | 输出上限 |
| `LLM_MAX_ATTEMPTS` | `3` | 含第一次的重试次数，`1` 表示关闭 |
| `LLM_JSON_MODE` | `true` | 请求厂商返回 JSON；不支持的实现设为 `false` |
| `LLM_STREAM_USAGE` | `true` | 流式请求附带用量帧；兼容性差的实现设为 `false` |
| `ASK_TIMEOUT_MS` | `90000` | 单次提问总预算，`0` 关闭 |
| `RATE_LIMIT_PER_MINUTE` | `30` | 每 IP 每分钟请求数 |
| `MAX_CONCURRENT_ASKS` | `8` | 同时在途的模型请求上限，`0` 关闭 |
| `LLM_DAILY_LIMIT` | 关闭 | 每日模型调用上限（进程内存，UTC 日界） |
| `SSE_HEARTBEAT_MS` | `15000` | 流式空闲心跳间隔，`0` 关闭 |
| `TRUST_PROXY` | 未设置 | 反向代理跳数；仅在确实有代理时设置 |
| `LLM_PRICE_INPUT_PER_M` / `LLM_PRICE_OUTPUT_PER_M` | — | 每百万 token 单价，两者必须同时配置 |
| `LLM_PRICE_CURRENCY` | `CNY` | 成本显示币种 |
| `MOCK_MISBEHAVE` | 空 | `unknown-field` 时故意引用不存在的字段，用于验证防线 |
| `MOCK_CHUNK_DELAY_MS` | `25` | mock 流式输出的块间延迟 |

`openai` 模式下缺少任一必填项，服务会拒绝启动，避免「以为接了真实模型、实际在跑假数据」。

`TRUST_PROXY` 两个方向都会出错，因此不提供默认值：

- 在代理后面却不设置：所有请求被算作同一个 IP，一个人刷满额度后其他人全部收到 `429`；
- 没有代理却设置：任何人都可以通过 `X-Forwarded-For` 更换身份，限流失效。

## 环境注意事项

### Node

`.nvmrc` 固定开发与 CI 使用的运行时（`24.22.0`）；`package.json` 的 `engines.node` 只声明最低要求 `>=22.12.0`，这个下限来自日志栈（nestjs-pino 5.x）。Dockerfile 的 `NODE_IMAGE` 与 `.nvmrc` 保持同一小版本，CI 通过 `node-version-file` 读取 `.nvmrc` —— 三处不一致的话，会出现「CI 绿了、镜像里跑不起来」。

npm 11（Node 24 自带）默认**不执行**依赖的 install 脚本。`package.json` 的 `allowScripts` 列出了确实需要执行的四个包：`@prisma/engines`、`prisma`、`esbuild`、`fsevents`。新增依赖如果带 `postinstall`，安装结束时会提示被跳过，需要 `npm install-scripts approve <pkg>` 显式放行 —— 这一步顺带成了一次供应链检查。

### Prisma 7

1. `url` 不能写在 `schema.prisma` 中，连接串位于 `prisma.config.ts`；
2. `PrismaClient` 必须传入 driver adapter（`new PrismaPg(...)`）；
3. generator 为 `prisma-client`，`output` 必填，生成的 client 位于 `src/generated/prisma`；
4. Prisma CLI 不自动读取 `.env`，需在 `prisma.config.ts` 中 `import 'dotenv/config'`。

### npm

npm 10.8.2 在部分依赖树上会抛出 `Cannot read properties of null (reading 'edgesOut')`。仓库中的 `.npmrc` 使用 `legacy-peer-deps=true` 规避，原因记录在该文件中。

### Docker Compose 中的数据库地址

宿主机运行使用 `localhost:5433`，容器内使用 `db:5432`。两个值都是正确的，但不可互换：容器里的 `localhost` 指向容器自身。错误表现是「连接被拒绝」，容易误判为数据库未启动。
