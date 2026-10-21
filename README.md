# assistant-demo

[![CI](https://github.com/lcylamb/assistant-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/lcylamb/assistant-demo/actions/workflows/ci.yml)

**[中文](README.zh-CN.md)**

Ask a natural-language question about an expense report and get a **structured, verifiable answer**: a conclusion, the fields it is based on, and whether the data was insufficient. Answers stream over SSE.

Open <http://localhost:3100> after `npm run start:dev`. The default provider is a mock, so no API key is required.

## Features

- **Structured output** — the model must return JSON; the complete answer is validated field by field, and malformed output results in `502` instead of a partial answer.
- **Verifiable evidence** — `evidence` only accepts fields returned by tools actually called during this request; unknown fields are removed and logged.
- **Tool calling** — the model fetches data through three read-only tools. The expense ID is bound by the server and cannot be chosen by the model.
- **Streaming** — the conclusion is extracted incrementally from partial JSON; streaming and non-streaming responses share the same final validation. True token-by-token streaming with a real provider; the mock simulates chunks.
- **Multi-turn** — the client sends back the previous turn's validated conclusion; the server keeps no session state.
- **Evaluated** — 23 cases cover tool trajectories, prompt injection, and cross-record access, run against a real database in CI.
- **Observable** — request IDs, access logs, latency / time-to-first-token / token / cost metrics, and rejected-request counters.
- **Mock-first** — a rule-based provider makes the full test suite reproducible without network access or credentials.

## Quick start

Requires Node 20+ and Docker.

```bash
cp .env.example .env      # defaults to PostgreSQL on localhost:5433
npm install
npm run db:up             # start PostgreSQL
npm run db:migrate        # create tables
npm run db:seed           # insert 10 fictional expense reports
npm run start:dev         # http://localhost:3100
```

Useful scripts:

| Command | Description |
|---|---|
| `npm run db:reset` | Reset the database and re-seed |
| `npm run db:studio` | Database browser (localhost:5555) |
| `npm run probe:stream` | Call the streaming endpoint and print arrival time per chunk |
| `npm run eval` / `eval:real` | Run the evaluation suite with mock / a real model |
| `npm run lint` / `npm test` / `npm run test:e2e` | Static checks and tests |
| `docker compose up --build` | Database + migrations + app in containers |

## Usage

### Single question

```bash
curl -X POST localhost:3100/assistant/ask \
  -H 'Content-Type: application/json' \
  -d '{"code":"BX-2026-0003","question":"Why was this report rejected?"}'
```

```json
{
  "conclusion": "BX-2026-0003 was rejected because the entertainment expense exceeded the department's monthly budget and the attendee list was missing.",
  "evidence": ["code", "status", "rejectReason"],
  "insufficient": false,
  "trace": [{ "tool": "get_approval_record", "ok": true }],
  "metrics": {
    "elapsedMs": 912,
    "ttftMs": null,
    "modelCalls": 2,
    "toolMs": 18,
    "usage": { "promptTokens": 1820, "completionTokens": 96 }
  }
}
```

When the data does not contain an answer, the response says so explicitly:

```json
{
  "conclusion": "BX-2026-0005 has not reached approval yet (draft), so there is no approval comment in the data.",
  "evidence": ["code", "status"],
  "insufficient": true,
  "trace": [{ "tool": "get_approval_record", "ok": true }]
}
```

### Streaming

`POST /assistant/askStream` takes the same body and returns `text/event-stream`:

```
event: delta
data: {"text":"This "}

event: delta
data: {"text":"report "}

event: done
data: {"conclusion":"…","evidence":["status"],"insufficient":false,"trace":[…],"metrics":{…}}

event: error
data: {"message":"Model call failed, please retry"}
```

`delta` contains incremental text that may be revised by later chunks; only `done` is final, and its payload has exactly the same shape as `/assistant/ask`. When the stream is idle for longer than `SSE_HEARTBEAT_MS`, the server sends an SSE comment frame (`: ping`), which clients should ignore per the SSE specification.

### Multi-turn

Pass `history` in the request body, containing previously validated conclusions:

```json
{
  "code": "BX-2026-0002",
  "question": "What was that money spent on?",
  "history": [
    {
      "question": "What is the total amount of this report?",
      "conclusion": "The reimbursement amount of BX-2026-0002 is ¥12800.00.",
      "evidence": ["code", "amount"],
      "insufficient": false
    }
  ]
}
```

At most 3 turns. History is context only; it does not expand which fields may be cited in the current turn.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/assistant/ask` | Returns an `AskResult` |
| `POST` | `/assistant/askStream` | SSE: `delta` → `done`, or `error` |
| `GET` | `/assistant/metrics` | In-process metrics snapshot |
| `GET` | `/health` | Runs `select 1`; returns `503` when the database is unavailable |

Every response carries `X-Request-Id`, and log lines are prefixed with `[req <id>]` to correlate a request.

| Status | Meaning |
|---|---|
| `400` | Request validation failed |
| `404` | Expense report not found |
| `429` | Rate limit, concurrency limit, or daily quota exceeded |
| `502` | Model call failed, or output failed format validation |
| `503` | Database unavailable |
| `504` | Overall request budget exceeded |

Once the streaming endpoint has written response headers, the status code can no longer change. Model failures, format errors, and mid-stream database failures therefore appear as `200` + an `error` frame.

## Design at a glance

```
request → validation → rate/concurrency guards → load expense → agent loop (model ↔ tools) → parse & filter → response
```

Key choices:

- **Model output is not trusted.** The complete answer is type-checked; cited fields must come from this request's tool results, otherwise they are removed. `502` is reserved for format errors, not for imperfect wording.
- **The expense ID is not a tool argument.** The server binds it, and there is no search-all or query-by-filter tool. The data a model can reach is decided by the server.
- **Streaming does not get its own parser.** Both endpoints share `prepare()` and `settle()`; incremental text is still validated in full when the stream ends.
- **Cancellation is wired before headers are sent.** The streaming endpoint listens for connection close before loading the expense, so an early client disconnect does not call the model or consume quota.
- **Three independent limits.** Rate, concurrency, and daily quota address scripted abuse, request pile-up, and budget exhaustion respectively.
- **Errors are classified by source.** Vendor failures are `502`, database failures `503`, timeouts `504`, and client cancellations are not counted as errors.

Detailed design notes: [docs/design.md](docs/design.md) (Chinese).

## Evaluation

23 cases, each sent to both endpoints. Most expected values are computed from the database rather than hard-coded.

```
npm run eval        (mock)      : 13 passed, 10 known gaps, 0 unexpected
npm run eval:real   (DeepSeek)  : 23 passed,  0 known gaps, 0 unexpected
```

- Structural checks are never waived: cited fields must exist, amounts and dates must be traceable, tools must not fail, and both endpoints must return the same conclusion under a deterministic provider.
- Trajectory checks require each case to call a designated tool, so a coincidentally correct answer does not pass.
- The 10 known gaps on mock correspond to capabilities the rule table lacks; all pass with a real model.
- The suite has been mutation-tested to fail when a defense is removed, so an all-green run is meaningful.

Case table, grading layers, and real-model results: [docs/evaluation.md](docs/evaluation.md) (Chinese).

## Testing and CI

```bash
npm test          # unit tests, no database required
npm run test:e2e  # end-to-end tests and evaluation, requires a database
npm run lint      # oxlint with type-aware checks
```

CI runs `lint` → `tsc --noEmit` → `build` → unit tests → end-to-end tests on every push and pull request. The database is provided by an Actions service container, migrated and seeded from scratch each run. The pipeline ends by building and starting the real container to verify health checks, one live request, no secrets in the image, a non-root process, and a clean `docker stop`.

CI runs the mock only; real-model evaluation is run locally.

## Configuration

Main variables:

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` or `openai` (OpenAI-compatible protocol) |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | — | Required when `LLM_PROVIDER=openai` |
| `RATE_LIMIT_PER_MINUTE` | `30` | Requests per IP per minute |
| `MAX_CONCURRENT_ASKS` | `8` | Max in-flight model requests; `0` disables |
| `LLM_DAILY_LIMIT` | off | Daily model-call quota |
| `ASK_TIMEOUT_MS` | `90000` | Total budget for one question |
| `LLM_TIMEOUT_MS` | `30000` | Per-call timeout |
| `SSE_HEARTBEAT_MS` | `15000` | Idle heartbeat interval for streams |
| `TRUST_PROXY` | unset | Number of trusted proxy hops; set only behind a proxy |

To use a real model, change `.env` only — no code changes:

```bash
LLM_PROVIDER=openai
LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

`npm run eval:real` then runs the same suite against that provider.

Full list and notes: [`.env.example`](.env.example) and [docs/operations.md](docs/operations.md) (Chinese).

## Deployment

```bash
docker compose up --build   # database + migrations + app
```

The image is built in five stages, runs as a non-root user, and contains no secrets. The app verifies the database on startup and does not wait for active connections on shutdown. The deployment target is Render + Neon; migrations are run manually from a local machine.

Details: [docs/operations.md](docs/operations.md) (Chinese).

## Known limitations

This is a demo project, not a production system:

- No authentication, authorization, or multi-tenant isolation.
- Metrics, rate limits, concurrency limits, and daily quota are in-process. Multiple instances count independently, and restarts reset them.
- No tracing, log aggregation, or cross-instance aggregation.
- The incremental parser does not guarantee `conclusion` is a top-level key; the full validation after the stream ends is the safety net.
- Cost estimates exclude cache pricing and are therefore an upper bound, not a bill.
- Mock token counts are estimated from character length, not tokenizer output.
- Real-model evaluation is a single sample; outputs are not guaranteed to be reproducible.

Out of scope: RAG (the data is structured, so querying the database directly is the right approach), complex agent orchestration, and conversation persistence.

## Data

All data in this repository is fictional: names are placeholders such as "Zhang San / Li Si / Wang Wu", with no real people, ID numbers, phone numbers, or data from any real business system. Amounts are invented as well.

The seed inserts 10 expense reports covering draft, pending approval, approved, rejected, and paid states, used by both normal-path and edge-case evaluations.
