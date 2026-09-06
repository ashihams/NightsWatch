# Agent runtime (Step 2)

Minimal Node/TypeScript planner that calls the mock CRM webhooks from `tools/`.

## AO session entrypoint

**One planner run** is `runOnePlanner(task)` in `src/runPlanner.ts`.

That function is the unit to wrap later as an AO session: input = natural-language task, output = tool-call trace + final message. No Neo4j / vector memory / reflection yet — keep the session boundary here.

```ts
import { runOnePlanner } from "./runPlanner.js";

const result = await runOnePlanner(
  "Find orders for Jordan Lee and open a support ticket about late shipment",
);
```

## Prerequisites

Start the mock tools in a separate terminal:

```bash
npm run tools
# listens on http://localhost:5678
```

## Run one sample task

```bash
npm install
cp .env.example .env   # optional — leave TensorMux blank for offline mode
npm run agent
```

Custom task:

```bash
npm run agent -- "Find orders for Sam Rivera"
```

## TensorMux (LLM path)

All LLM calls go through TensorMux (OpenAI-compatible chat completions).

| Env | Purpose |
|-----|---------|
| `TENSORMUX_BASE_URL` | Gateway base URL ending in `/v1` |
| `TENSORMUX_API_KEY` | API key |
| `TENSORMUX_MODEL` | Model id (default `gpt-4o-mini`) |

If either base URL or API key is missing, the runner uses a **deterministic offline planner** that still POSTs to the webhooks so demos work without credentials.

## Offline / naive behavior (intentional)

The offline planner **calls `list_orders` before resolving `customer_id`**. That miss (HTTP 400 `missing_customer_id` or an unscoped order list) is the teaching signal for later learning — not a bug in this step.

Tool calls are logged to stdout as JSON lines: `name`, `args`, `status`, `ok`, `latency_ms`.

## Layout

| Path | Role |
|------|------|
| `src/runPlanner.ts` | `runOnePlanner` — AO-wrappable entrypoint |
| `src/index.ts` | CLI / `npm run agent` |
| `src/tools.ts` | Webhook client + schemas + stdout logging |
| `src/llm.ts` | TensorMux OpenAI client |
| `src/offlinePlanner.ts` | Deterministic naive fallback |
