# Agent runtime (Step 2 + Neatlogs observability)

Minimal Node/TypeScript planner that calls the mock CRM webhooks from `tools/`, with Neatlogs OpenTelemetry tracing for agent / LLM / tool spans.

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
cp .env.example .env   # optional — leave TensorMux / Neatlogs blank for offline + no export
npm run agent
```

Custom task:

```bash
npm run agent -- "Find orders for Sam Rivera"
```

## Neatlogs observability

Init happens once in `src/observability.ts`, called at the very start of `src/index.ts` (before planner / tool loops).

| Env | Purpose |
|-----|---------|
| `NEATLOGS_API_KEY` | Project API key from [app.neatlogs.com](https://app.neatlogs.com). Required to export traces. |
| `NEATLOGS_ENDPOINT` | Optional ingest base URL (default `https://ingest.neatlogs.com`) |
| `NEATLOGS_WORKFLOW_NAME` | Optional workflow label in the dashboard (default `support-agent-planner`) |

**Missing key:** stdout shows `[neatlogs] NEATLOGS_API_KEY missing — tracing disabled…` and the agent continues.

**With key:** stdout shows `[neatlogs] init ok — …`. Spans emitted:

- **AGENT** — `runOnePlanner`
- **TOOL** — each mock CRM webhook call (`callTool`)
- **LLM** — TensorMux chat completions via `wrapOpenAI` (when TensorMux is configured)

### Finding the session / trace in the dashboard

1. Set `NEATLOGS_API_KEY` in `.env` and run `npm run agent` (with `npm run tools` up).
2. Open [https://app.neatlogs.com](https://app.neatlogs.com).
3. Open the project that owns your API key.
4. Filter or search workflows by `support-agent-planner` (or your `NEATLOGS_WORKFLOW_NAME`).
5. Open the newest trace — you should see the agent root with nested tool (and LLM, on the TensorMux path) spans.
6. Session grouping follows Neatlogs defaults: a single CLI run is one trace/session unless you set an explicit session id later.

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
| `src/index.ts` | CLI / `npm run agent` (inits Neatlogs first) |
| `src/observability.ts` | Neatlogs init / graceful skip / span helpers |
| `src/tools.ts` | Webhook client + TOOL spans + stdout logging |
| `src/llm.ts` | TensorMux OpenAI client (+ `wrapOpenAI` when tracing) |
| `src/offlinePlanner.ts` | Deterministic naive fallback |
