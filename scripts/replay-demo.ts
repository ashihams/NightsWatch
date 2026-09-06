/**
 * Step 9 — demo replay spine (trajectory capture).
 *
 * Preconditions:
 *   Mock CRM tools must be up: `npm run tools` (listens on http://localhost:5678).
 *
 * Runs the committed scenario pack (seen_a → seen_b → unseen) through the real
 * local stack via `runOnePlanner` — does not reimplement the planner loop.
 *
 * Metrics come from working memory, episodic rows, analyzer/reflection results,
 * and the semantic lesson store (Neo4j or local fallback). Tokens are reported
 * as stored (0 when TensorMux usage is unavailable).
 *
 * Improvement assertion (exit non-zero if unmet):
 *   At least one clear signal must hold after the three runs:
 *   (A) unseen failed_tool_calls < seen_a failed_tool_calls, OR
 *   (B) unseen success && !seen_a success (task success = no unscoped/failed
 *       list_orders and at least one scoped list_orders), OR
 *   (C) unseen lessons_retrieved > 0 while seen_a lessons_retrieved === 0
 *       (shared-factor / direct injection fired on the unseen wording).
 */

import { config } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initObservability, shutdownObservability } from "../agent/src/observability.js";
import { runOnePlanner, type PlannerRunResult } from "../agent/src/runPlanner.js";
import {
  clearLocalSemanticStore,
  closeSemanticMemory,
  semanticFallbackPath,
} from "../agent/src/semanticMemory.js";
import { getInjectedSemanticLessons } from "../agent/src/strategy.js";
import { getInjectedContext, getWorkingRun } from "../agent/src/workingMemory.js";
import { listEpisodes } from "../agent/src/episodicMemory.js";
import type { ToolCallResult } from "../agent/src/tools.js";

/** Written for the demo dashboard (`npm run dashboard`). */
export const REPLAY_TRAJECTORY_PATH = "./data/replay-demo/trajectory.json";

config({ path: resolve(process.cwd(), ".env") });

type ScenarioLabel = "seen_a" | "seen_b" | "unseen";

type Scenario = {
  label: ScenarioLabel;
  task: string;
};

type TrajectoryRow = {
  run_id: string;
  label: ScenarioLabel;
  success: boolean;
  tool_call_count: number;
  failed_tool_calls: number;
  failed_list_orders: number;
  first_tool: string | null;
  tool_sequence: string[];
  latency_ms: number;
  tokens: number;
  lessons_retrieved: number;
  lessons_promoted: string[];
  retrieval_path: string | null;
  analyzer_flagged: boolean | null;
  reflection_status: "promoted" | "candidate" | "skipped" | "failed";
};

function loadScenarios(): Scenario[] {
  const path = resolve(
    process.cwd(),
    "scripts/scenarios/replay-demo.json",
  );
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    scenarios: Scenario[];
  };
  const labels = raw.scenarios.map((s) => s.label);
  for (const need of ["seen_a", "seen_b", "unseen"] as const) {
    if (!labels.includes(need)) {
      throw new Error(`scenario pack missing label: ${need}`);
    }
  }
  return raw.scenarios;
}

function isFailedOrUnscopedListOrders(c: ToolCallResult): boolean {
  if (c.name !== "list_orders") return false;
  const hasId = Boolean(c.args?.customer_id);
  if (!hasId) return true;
  if (!c.ok) return true;
  if (
    c.body &&
    typeof c.body === "object" &&
    ((c.body as { error?: string }).error === "missing_customer_id" ||
      (c.body as { unscoped?: boolean }).unscoped === true)
  ) {
    return true;
  }
  return false;
}

/** Task-level success for the demo trajectory (not merely working_runs complete). */
function taskSuccess(toolCalls: ToolCallResult[]): boolean {
  const failedList = toolCalls.filter(isFailedOrUnscopedListOrders).length;
  const scopedOk = toolCalls.some(
    (c) =>
      c.name === "list_orders" &&
      c.ok &&
      Boolean(c.args?.customer_id) &&
      !isFailedOrUnscopedListOrders(c),
  );
  return failedList === 0 && scopedOk;
}

function failedToolCalls(toolCalls: ToolCallResult[]): number {
  return toolCalls.filter((c) => !c.ok || isFailedOrUnscopedListOrders(c)).length;
}

function episodeForRun(runId: string): {
  latency_ms: number;
  token_count: number;
} | null {
  const hit = listEpisodes(50).find((e) => e.run_id === runId);
  if (!hit) return null;
  return { latency_ms: hit.latency_ms, token_count: hit.token_count };
}

function captureRow(
  label: ScenarioLabel,
  result: PlannerRunResult,
  wallLatencyMs: number,
): TrajectoryRow {
  const injected = getInjectedContext(result.runId);
  const semantic = getInjectedSemanticLessons(injected);
  const episode = episodeForRun(result.runId);
  const working = getWorkingRun(result.runId);

  const promoted: string[] = [];
  if (result.reflection?.promoted && result.reflection.lesson.id) {
    promoted.push(result.reflection.lesson.id);
  }

  let reflection_status: TrajectoryRow["reflection_status"] = "skipped";
  if (result.reflection) {
    reflection_status = result.reflection.lesson.usable
      ? "promoted"
      : "candidate";
  } else if (result.analysis?.flagged) {
    reflection_status = "failed";
  }

  const retrieval_path =
    semantic[0]?.retrieval_path ??
    (working && semantic.length === 0 ? null : null);

  return {
    run_id: result.runId,
    label,
    success: taskSuccess(result.toolCalls),
    tool_call_count: result.toolCalls.length,
    failed_tool_calls: failedToolCalls(result.toolCalls),
    failed_list_orders: result.toolCalls.filter(isFailedOrUnscopedListOrders)
      .length,
    first_tool: result.toolCalls[0]?.name ?? null,
    tool_sequence: result.toolCalls.map((c) => c.name),
    latency_ms: episode?.latency_ms ?? wallLatencyMs,
    tokens: episode?.token_count ?? 0,
    lessons_retrieved: semantic.length,
    lessons_promoted: promoted,
    retrieval_path: semantic[0]?.retrieval_path ?? retrieval_path,
    analyzer_flagged: result.analysis?.flagged ?? null,
    reflection_status,
  };
}

function printRow(row: TrajectoryRow): void {
  console.log(
    JSON.stringify({
      type: "replay_row",
      run_id: row.run_id,
      label: row.label,
      success: row.success,
      tool_call_count: row.tool_call_count,
      failed_tool_calls: row.failed_tool_calls,
      failed_list_orders: row.failed_list_orders,
      latency_ms: row.latency_ms,
      tokens: row.tokens,
      lessons_retrieved: row.lessons_retrieved,
      lessons_promoted: row.lessons_promoted,
      first_tool: row.first_tool,
      tool_sequence: row.tool_sequence,
      retrieval_path: row.retrieval_path,
      analyzer_flagged: row.analyzer_flagged,
      reflection_status: row.reflection_status,
    }),
  );
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printComparisonTable(rows: TrajectoryRow[]): void {
  console.log("\n=== trajectory comparison ===");
  const header = [
    pad("label", 8),
    pad("success", 8),
    pad("tools", 6),
    pad("fail", 5),
    pad("list_fail", 9),
    pad("lat_ms", 8),
    pad("tok", 5),
    pad("lessons", 8),
    pad("promoted", 10),
    "first_tool",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        pad(r.label, 8),
        pad(String(r.success), 8),
        pad(String(r.tool_call_count), 6),
        pad(String(r.failed_tool_calls), 5),
        pad(String(r.failed_list_orders), 9),
        pad(String(r.latency_ms), 8),
        pad(String(r.tokens), 5),
        pad(String(r.lessons_retrieved), 8),
        pad(
          r.lessons_promoted.length ? r.lessons_promoted.join(",") : "-",
          10,
        ),
        r.first_tool ?? "-",
      ].join(" "),
    );
  }
}

/** Persist last demo spine for the read-only dashboard API. */
function writeTrajectoryArtifact(rows: TrajectoryRow[]): string {
  const path = resolve(
    process.cwd(),
    process.env.REPLAY_TRAJECTORY_PATH || REPLAY_TRAJECTORY_PATH,
  );
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    type: "replay_trajectory",
    updated_at: new Date().toISOString(),
    rows,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

type ImprovementSignal = {
  id: "A" | "B" | "C";
  ok: boolean;
  detail: string;
};

function evaluateImprovement(rows: TrajectoryRow[]): ImprovementSignal[] {
  const seenA = rows.find((r) => r.label === "seen_a");
  const unseen = rows.find((r) => r.label === "unseen");
  if (!seenA || !unseen) {
    throw new Error("missing seen_a or unseen rows");
  }

  return [
    {
      id: "A",
      ok: unseen.failed_tool_calls < seenA.failed_tool_calls,
      detail: `unseen.failed_tool_calls (${unseen.failed_tool_calls}) < seen_a (${seenA.failed_tool_calls})`,
    },
    {
      id: "B",
      ok: unseen.success && !seenA.success,
      detail: `unseen.success (${unseen.success}) && !seen_a.success (${seenA.success})`,
    },
    {
      id: "C",
      ok: unseen.lessons_retrieved > 0 && seenA.lessons_retrieved === 0,
      detail: `unseen.lessons_retrieved (${unseen.lessons_retrieved}) > 0 && seen_a === 0`,
    },
  ];
}

function prepareDemoStores(): void {
  // Isolate demo SQLite / lesson files under data/replay-demo/
  process.env.WORKING_DB_PATH =
    process.env.REPLAY_WORKING_DB_PATH || "./data/replay-demo/working.sqlite";
  process.env.EPISODIC_DB_PATH =
    process.env.REPLAY_EPISODIC_DB_PATH || "./data/replay-demo/episodic.sqlite";
  process.env.SEMANTIC_FALLBACK_PATH =
    process.env.REPLAY_SEMANTIC_FALLBACK_PATH ||
    "./data/replay-demo/semantic_lessons.json";
  process.env.PENDING_REFLECTION_DIR =
    process.env.REPLAY_PENDING_REFLECTION_DIR ||
    "./data/replay-demo/pending_reflection";

  // Strategy on for the full trajectory (seen runs teach; unseen retrieves).
  process.env.STRATEGY_INJECTION = process.env.STRATEGY_INJECTION || "1";
  // Raise direct-match confidence so differently worded unseen tasks use the
  // shared-factor retrieval path (lesson confidence after promotion is ~0.7).
  if (!process.env.STRATEGY_MIN_CONFIDENCE) {
    process.env.STRATEGY_MIN_CONFIDENCE = "0.95";
  }

  // Prefer clean local fallback unless Neo4j is fully configured.
  if (
    !(process.env.NEO4J_URI || "").trim() ||
    !(process.env.NEO4J_USER || "").trim() ||
    !(process.env.NEO4J_PASSWORD || "").trim()
  ) {
    clearLocalSemanticStore();
    console.log(
      JSON.stringify({
        type: "replay_demo_reset",
        store: semanticFallbackPath(),
        working_db: process.env.WORKING_DB_PATH,
        episodic_db: process.env.EPISODIC_DB_PATH,
      }),
    );
  }
}

async function pingTools(): Promise<void> {
  const base = (process.env.TOOLS_BASE_URL || "http://localhost:5678").replace(
    /\/$/,
    "",
  );
  try {
    const res = await fetch(`${base}/webhook/search_customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "ping" }),
    });
    // Any HTTP response means the mock server is up.
    if (res.status < 100) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Mock tools not reachable at ${base} (${msg}). Start them with: npm run tools`,
    );
  }
}

async function main(): Promise<void> {
  prepareDemoStores();
  await pingTools();
  await initObservability();

  const scenarios = loadScenarios();
  const rows: TrajectoryRow[] = [];

  try {
    console.log(
      JSON.stringify({
        type: "replay_demo_start",
        scenarios: scenarios.map((s) => ({ label: s.label, task: s.task })),
        note: "Uses runOnePlanner; mock tools required on :5678",
      }),
    );

    for (const scenario of scenarios) {
      console.log(`\n=== ${scenario.label} ===`);
      console.log(
        JSON.stringify({
          type: "replay_scenario",
          label: scenario.label,
          task: scenario.task,
        }),
      );
      const t0 = Date.now();
      const result = await runOnePlanner(scenario.task);
      const row = captureRow(scenario.label, result, Date.now() - t0);
      rows.push(row);
      printRow(row);
    }

    printComparisonTable(rows);

    const trajectoryPath = writeTrajectoryArtifact(rows);
    console.log(
      JSON.stringify({
        type: "replay_trajectory_written",
        path: trajectoryPath,
        row_count: rows.length,
      }),
    );

    const seenA = rows.find((r) => r.label === "seen_a")!;
    const seenB = rows.find((r) => r.label === "seen_b")!;
    const unseen = rows.find((r) => r.label === "unseen")!;

    const signals = evaluateImprovement(rows);
    const anyOk = signals.some((s) => s.ok);

    console.log("\n=== trajectory summary ===");
    console.log(
      JSON.stringify(
        {
          type: "replay_demo_summary",
          seen_a: {
            success: seenA.success,
            failed_tool_calls: seenA.failed_tool_calls,
            failed_list_orders: seenA.failed_list_orders,
            lessons_retrieved: seenA.lessons_retrieved,
            reflection_status: seenA.reflection_status,
            first_tool: seenA.first_tool,
          },
          seen_b: {
            success: seenB.success,
            failed_tool_calls: seenB.failed_tool_calls,
            failed_list_orders: seenB.failed_list_orders,
            lessons_retrieved: seenB.lessons_retrieved,
            reflection_status: seenB.reflection_status,
            lessons_promoted: seenB.lessons_promoted,
            first_tool: seenB.first_tool,
          },
          unseen: {
            success: unseen.success,
            failed_tool_calls: unseen.failed_tool_calls,
            failed_list_orders: unseen.failed_list_orders,
            lessons_retrieved: unseen.lessons_retrieved,
            retrieval_path: unseen.retrieval_path,
            first_tool: unseen.first_tool,
            tool_sequence: unseen.tool_sequence,
          },
          improvement: {
            failed_list_orders_delta:
              seenA.failed_list_orders - unseen.failed_list_orders,
            failed_tool_calls_delta:
              seenA.failed_tool_calls - unseen.failed_tool_calls,
            success_rose: unseen.success && !seenA.success,
            lessons_injected_on_unseen: unseen.lessons_retrieved,
            note: "Expected: failed list_orders drops on unseen; success rises via shared-factor lesson injection",
          },
          assertion: {
            require: "at least one of A/B/C",
            signals,
            passed: anyOk,
          },
        },
        null,
        2,
      ),
    );

    if (!anyOk) {
      console.error(
        "replay:demo assertion failed — no clear improvement signal (A/B/C). See scripts/replay-demo.ts header.",
      );
      process.exitCode = 1;
    } else {
      console.log(
        JSON.stringify({
          type: "replay_demo_ok",
          signals_passed: signals.filter((s) => s.ok).map((s) => s.id),
        }),
      );
    }
  } finally {
    await closeSemanticMemory();
    await shutdownObservability();
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeSemanticMemory().catch(() => undefined);
  await shutdownObservability().catch(() => undefined);
  process.exit(1);
});
