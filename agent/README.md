# Agent runtime (Steps 2–7)

Minimal Node/TypeScript planner that calls the mock CRM webhooks from `tools/`, with Neatlogs OpenTelemetry tracing, SQLite **working memory**, SQLite **episodic vector memory**, a **deterministic post-run analyzer**, a **reflection LLM** (TensorMux / offline fallback), and **Neo4j semantic memory** with an evidence gate.

## AO session entrypoint

**One planner run** is `runOnePlanner(task)` in `src/runPlanner.ts`.

That function is the unit to wrap later as an AO session: input = natural-language task, output = tool-call trace + final message + analyzer verdict + optional reflected lesson. Strategy injection of usable lessons into new tasks is **Step 8** — this step only stores candidates / promotes them.

```ts
import { runOnePlanner } from "./runPlanner.js";

const result = await runOnePlanner(
  "Find orders for Jordan Lee and open a support ticket about late shipment",
);
// result.analysis?.flagged, result.reflection?.lesson.usable
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
cp .env.example .env   # optional — leave TensorMux / Neo4j / Neatlogs blank for offline
npm run agent
```

Custom task:

```bash
npm run agent -- "Find orders for Sam Rivera"
```

## Reflection + semantic memory (Step 7)

After the analyzer, **only if `flagged === true`**:

1. **Reflect** — TensorMux chat completion (same gateway as the planner) proposes a structured candidate lesson. If TensorMux is unset/fails, a **deterministic offline reflection** still emits a candidate from analyzer triggers (e.g. `missing_customer_id` / bad `list_orders` usage). Neatlogs traces the LLM call when configured (`wrapOpenAI` + `reflectOnFlaggedRun` span).
2. **Store** — upsert into Neo4j (or local JSON fallback):
   - `(:Run)-[:ENCOUNTERED]->(:Situation)-[:HAS_FACTOR]->(:Factor)`
   - `(:Situation)-[:RESOLVED_BY]->(:Lesson)-[:APPLIES_TO]->(:Tool)`
   - `(:Lesson)-[:SUPPORTED_BY]->(:Run)`
3. **Evidence gate**
   - First sighting: `evidence_count=1`, `usable=false` (**candidate** — not eligible for planner injection yet)
   - Second independent corroborating run (same situation/factors/tool): `evidence_count>=2`, confidence set, `usable=true` (**promoted**)

Stdout pipeline: `analyzer_result` → `reflection_gate` (`flagged`) → `reflection_result` (`reflected`) → `semantic_memory_upsert` (`candidate` | `promoted`).

### Neo4j env (AuraDB-friendly)

| Env | Purpose |
|-----|---------|
| `NEO4J_URI` | Bolt / `neo4j+s://…` Aura URI |
| `NEO4J_USER` | Username (often `neo4j`) |
| `NEO4J_PASSWORD` | Password |
| `SEMANTIC_FALLBACK_PATH` | Local JSON store when Neo4j unset/unreachable (default `./data/semantic_lessons.json`) |

**Missing / unreachable Neo4j:** log a warning and keep writing candidate lessons to the local fallback — **do not crash** the agent.

### Prove two-run promotion

```bash
# needs npm run tools on :5678; leave Neo4j blank for local fallback demo
npm run reflection:prove
# → run 1: candidate evidence_count=1 usable=false
# → run 2: promoted evidence_count>=2 usable=true

npm run memory:lessons   # or: npm run neo4j:lessons
```

## Deterministic analyzer (Step 6)

After every completed (or failed) run, `runOnePlanner` always calls the pure function `analyzeRun` (via `analyzeCompletedRun`).

### Return shape

```ts
analyzeRun(input) → {
  flagged: boolean,
  triggers: string[],   // which fixed conditions fired
  evidence: object      // structured details per trigger
}
```

### Fixed triggers (flag if any are true)

| Trigger | Condition |
|---------|-----------|
| `tool_failure` | Non-2xx status, `ok: false`, or explicit error body |
| `retry` | Same tool called again after an earlier failure in the run |
| `duplicate_tool_call` | Same tool + same effective inputs more than once |
| `high_latency` | Run latency ≥ median of prior similar episodes (skipped if no baseline) |
| `novel_tool_sequence` | Successful tool sequence not seen in prior successful episodes (skipped if no prior success history) |

### Data paths (same triggers)

1. **Neatlogs (preferred)** — when `NEATLOGS_API_KEY` is set, the loader calls the Neatlogs MCP session/trace API and maps TOOL spans into normalized tool calls.
2. **Working memory (fallback)** — if Neatlogs is unset or the read fails/empty, use `working_runs.tool_call_log`, then in-memory tool results.

### Pending reflection

If `flagged === true`, write `{PENDING_REFLECTION_DIR}/{run_id}.json`, then after a successful reflection mark `status: "reflected"` with `lesson_id` / `evidence_count`.

```bash
npm run analyzer:prove
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

Lifecycle: insert on start → retrieve episodic soft context (when no semantic lessons yet) → append after each tool call → set status on end → write episodic row → **analyzer → reflect → semantic upsert**.

```bash
npm run working:list
```

Requires Node with built-in `node:sqlite` (Node ≥ 22.5). The `data/` directory is gitignored.

## Episodic memory (SQLite vectors)

**Choice:** local SQLite table + JSON float embeddings + in-process cosine similarity.

| Env | Purpose |
|-----|---------|
| `EPISODIC_DB_PATH` | SQLite path (default `./data/episodic.sqlite`) |
| `EPISODIC_RETRIEVE_K` | Top-k nearest episodes to inject (default `3`) |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | Optional API embeddings; blank → offline hash |

**Run-start injection:** if `injected_context` has no `semantic_lesson` entries, query episodic memory and store hits as soft context. Step 8 will inject usable Neo4j lessons instead.

```bash
npm run episodic:list
```

## Neatlogs observability

Init once in `src/observability.ts` at the start of `src/index.ts`.

| Env | Purpose |
|-----|---------|
| `NEATLOGS_API_KEY` | Project API key from [app.neatlogs.com](https://app.neatlogs.com) |
| `NEATLOGS_ENDPOINT` | Optional ingest base URL |
| `NEATLOGS_MCP_URL` | Optional MCP URL for analyzer reads |
| `NEATLOGS_WORKFLOW_NAME` | Optional workflow label (default `nights-watch-agent`) |

**Missing key:** tracing skipped with a warning; agent continues.

**With key:** AGENT / TOOL / LLM spans (planner + reflection via TensorMux `wrapOpenAI`).

## TensorMux (LLM path)

All LLM calls (planner **and** reflection) go through TensorMux.

| Env | Purpose |
|-----|---------|
| `TENSORMUX_BASE_URL` | Gateway base URL ending in `/v1` |
| `TENSORMUX_API_KEY` | API key |
| `TENSORMUX_MODEL` | Model id (default `gpt-4o-mini`) |

If missing, the runner uses the **deterministic offline planner** and **offline reflection** so demos work without credentials.

## Offline / naive behavior (intentional)

The offline planner **calls `list_orders` before resolving `customer_id`**. That miss (`missing_customer_id` / unscoped) is the teaching signal. The analyzer flags it; reflection proposes the lesson; a second corroborating run promotes it.

## Layout

| Path | Role |
|------|------|
| `src/runPlanner.ts` | `runOnePlanner` — AO entrypoint + memories + analyzer + reflection |
| `src/analyzer.ts` | Pure `analyzeRun` |
| `src/analyzeCompletedRun.ts` | Neatlogs-or-working-memory loader → `analyzeRun` |
| `src/reflection.ts` | TensorMux / offline candidate lesson |
| `src/semanticMemory.ts` | Neo4j graph + local fallback + evidence gate |
| `src/listLessons.ts` | `npm run memory:lessons` / `neo4j:lessons` |
| `src/proveReflection.ts` | `npm run reflection:prove` — two-run promotion |
| `src/pendingReflection.ts` | Local pending/reflected JSON records |
| `src/proveAnalyzer.ts` | `npm run analyzer:prove` |
| `src/workingMemory.ts` | SQLite `working_runs` |
| `src/episodicMemory.ts` | SQLite episodes + retrieve/write |
| `src/embeddings.ts` | Offline hash + optional API embeddings |
| `src/index.ts` | CLI / `npm run agent` |
| `src/observability.ts` | Neatlogs init / spans |
| `src/tools.ts` | Webhook client |
| `src/llm.ts` | TensorMux planner client |
| `src/offlinePlanner.ts` | Deterministic naive fallback |
