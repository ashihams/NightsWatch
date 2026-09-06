# Agent runtime (Steps 2–5)

Minimal Node/TypeScript planner that calls the mock CRM webhooks from `tools/`, with Neatlogs OpenTelemetry tracing, SQLite **working memory** for the in-flight run, and SQLite **episodic vector memory** written after every run.

## AO session entrypoint

**One planner run** is `runOnePlanner(task)` in `src/runPlanner.ts`.

That function is the unit to wrap later as an AO session: input = natural-language task, output = tool-call trace + final message. No Neo4j / reflection / deterministic analyzer yet — keep the session boundary here.

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
cp .env.example .env   # optional — leave TensorMux / Neatlogs / embedding blank for offline
npm run agent
```

Custom task:

```bash
npm run agent -- "Find orders for Sam Rivera"
```

## Working memory (SQLite)

One row per planner run in `working_runs` (path via `WORKING_DB_PATH`, default `./data/working.sqlite`):

| Column | Role |
|--------|------|
| `run_id` | Primary key |
| `task_description` | Natural-language task |
| `status` | `in_progress` → `complete` \| `failed` |
| `started_at` | ISO timestamp |
| `current_step` | Tool-call count so far |
| `tool_call_log` | JSON append-only log of tool calls this run |
| `injected_context` | JSON soft context (episodic hits; later: semantic lessons) |

Lifecycle inside `runOnePlanner`: insert on start → retrieve episodic soft context into `injected_context` (when no semantic lessons yet) → append after each tool call → set status on end → write episodic row.

Inspect recent rows:

```bash
npm run working:list
```

Requires Node with built-in `node:sqlite` (Node ≥ 22.5). The `data/` directory is gitignored.

## Episodic memory (SQLite vectors)

**Choice:** local SQLite table + JSON float embeddings + in-process cosine similarity. Fastest free-tier / zero-infra option for the hackathon — no Neo4j, Chroma, Pinecone, or paid vector host required.

| Env | Purpose |
|-----|---------|
| `EPISODIC_DB_PATH` | SQLite path (default `./data/episodic.sqlite`) |
| `EPISODIC_RETRIEVE_K` | Top-k nearest episodes to inject (default `3`) |
| `EMBEDDING_BASE_URL` | Optional OpenAI-compatible embeddings base (`…/v1`) |
| `EMBEDDING_API_KEY` | Optional embeddings API key |
| `EMBEDDING_MODEL` | Optional model id (default `text-embedding-3-small`) |

Each episode stores: `id`, `run_id`, `situation_summary` (short NL text that was embedded), `embedding`, `tool_sequence`, `success`, `tool_call_count`, `token_count` (0 for now), `latency_ms`, `created_at`.

**Write path:** after every run ends (success or fail), unconditionally `writeEpisode(...)`.

**Retrieval API:** `retrieveEpisodes(task, k=3)` embeds the new task and returns top-k nearest episodes by cosine similarity.

**Run-start injection:** if `injected_context` has no `semantic_lesson` entries (none exist yet), query episodic memory and store the hits as soft context (`type: "episodic"`). Stdout logs `episodic_retrieve` / `episodic_inject` with retrieved `run_id`s and summaries.

### Offline / no-embed-key path

When `EMBEDDING_BASE_URL` + `EMBEDDING_API_KEY` are unset (or the API call fails), embeddings use a **deterministic bag-of-words hashing-trick** vector (`hash-bow-256`). Demos and CI work with zero paid embed APIs. Same text → same vector; overlapping tokens → higher similarity.

Inspect episodes:

```bash
npm run episodic:list
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

The offline planner **calls `list_orders` before resolving `customer_id`**. That miss (HTTP 400 `missing_customer_id` or an unscoped order list) is the teaching signal for later learning — not a bug in this step. The miss is recorded in `tool_call_log` and in the episode's `tool_sequence` / `situation_summary`.

Tool calls are logged to stdout as JSON lines: `name`, `args`, `status`, `ok`, `latency_ms`.

## Layout

| Path | Role |
|------|------|
| `src/runPlanner.ts` | `runOnePlanner` — AO entrypoint + working + episodic lifecycle |
| `src/workingMemory.ts` | SQLite `working_runs` store |
| `src/episodicMemory.ts` | SQLite episodes + retrieve/write API |
| `src/embeddings.ts` | Offline hash embeddings + optional API embeddings |
| `src/listWorking.ts` | `npm run working:list` inspector |
| `src/listEpisodic.ts` | `npm run episodic:list` inspector |
| `src/index.ts` | CLI / `npm run agent` (inits Neatlogs first) |
| `src/observability.ts` | Neatlogs init / graceful skip / span helpers |
| `src/tools.ts` | Webhook client + TOOL spans + stdout logging |
| `src/llm.ts` | TensorMux OpenAI client (+ `wrapOpenAI` when tracing) |
| `src/offlinePlanner.ts` | Deterministic naive fallback |
