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
  clearSemanticStore,
  closeSemanticMemory,
  semanticFallbackPath,
} from "../agent/src/semanticMemory.js";
import { getInjectedSemanticLessons } from "../agent/src/strategy.js";
import { getInjectedContext, getWorkingRun } from "../agent/src/workingMemory.js";
import { listEpisodes } from "../agent/src/episodicMemory.js";
import type { ToolCallResult } from "../agent/src/tools.js";
import {
  buildAgentVersionScorecard,
  computeLoopEvalMetrics,
  computeTaskSuccess,
  formatAgentVersionScorecardTable,
  type AgentVersionScorecard,
  type LoopEvalMetrics,
} from "../agent/src/evalMetrics.js";
/** Written for the demo dashboard (`npm run dashboard`). */
export const REPLAY_TRAJECTORY_PATH = "./data/replay-demo/trajectory.json";

config({ path: resolve(process.cwd(), ".env"), override: true });

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
  /** Per-run loop_eval (includes task_success, speed, robustness). */
  eval_metrics: LoopEvalMetrics;
  /** Agent version bucket for this run (v1/v2/v3). Filled after spine completes. */
  agent_version?: "v1" | "v2" | "v3";
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
  return computeTaskSuccess(
    toolCalls.map((c) => ({
      name: c.name,
      ok: c.ok,
      status: c.status,
      latencyMs: c.latencyMs,
      body: c.body,
      args: c.args,
    })),
  );
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

  const eval_metrics = computeLoopEvalMetrics({
    latencyMs: episode?.latency_ms ?? wallLatencyMs,
    toolCalls: result.toolCalls.map((c) => ({
      name: c.name,
      ok: c.ok,
      status: c.status,
      latencyMs: c.latencyMs,
      body: c.body,
      args: c.args,
    })),
    analyzerTriggers: result.analysis?.triggers,
  });
  // Prefer tokens already recorded on the eval blob / episode when present.
  if (episode?.token_count) {
    eval_metrics.token_total = episode.token_count;
  } else if (
    result.evalMetrics &&
    typeof result.evalMetrics.token_total === "number"
  ) {
    eval_metrics.token_total = result.evalMetrics.token_total as number;
  }

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
    eval_metrics,
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
      task_success: row.eval_metrics.task_success,
      speed_score: row.eval_metrics.speed_score,
      robustness_score: row.eval_metrics.robustness_score,
      agent_version: row.agent_version ?? null,
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
function writeTrajectoryArtifact(
  rows: TrajectoryRow[],
  scorecard: AgentVersionScorecard,
): string {
  const path = resolve(
    process.cwd(),
    process.env.REPLAY_TRAJECTORY_PATH || REPLAY_TRAJECTORY_PATH,
  );
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    type: "replay_trajectory",
    updated_at: new Date().toISOString(),
    rows,
    scorecard,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

function buildScorecardFromRows(rows: TrajectoryRow[]): {
  rows: TrajectoryRow[];
  scorecard: AgentVersionScorecard;
} {
  const scorecard = buildAgentVersionScorecard(
    rows.map((r) => ({
      run_id: r.run_id,
      label: r.label,
      reflection_status: r.reflection_status,
      lessons_promoted: r.lessons_promoted,
      lessons_retrieved: r.lessons_retrieved,
      first_tool: r.first_tool,
      metrics: r.eval_metrics,
    })),
  );
  const versionByRun = new Map<string, "v1" | "v2" | "v3">();
  for (const bucket of scorecard.rows) {
    for (const id of bucket.run_ids) {
      versionByRun.set(id, bucket.version);
    }
  }
  const stamped = rows.map((r) => ({
    ...r,
    agent_version: versionByRun.get(r.run_id),
  }));
  return { rows: stamped, scorecard };
}

function printAgentVersionScorecard(scorecard: AgentVersionScorecard): void {
  console.log(
    "\n=== Agent v1 → v2 → v3 scorecard (lesson-promotion boundaries) ===",
  );
  console.log(formatAgentVersionScorecardTable(scorecard));
  console.log(
    JSON.stringify({
      type: "agent_version_scorecard",
      bucketing: scorecard.bucketing,
      note: scorecard.note,
      comparison: scorecard.comparison,
      rows: scorecard.rows,
    }),
  );
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

export type ReplayDemoResult = {
  ok: boolean;
  rows: TrajectoryRow[];
  trajectory_path: string;
  signals: ImprovementSignal[];
  exit_code: number;
  scorecard?: AgentVersionScorecard;
};

export type RunReplayDemoOptions = {
  /** Force offline planner + hash embeddings (Vercel / no localhost deps). */
  forceOffline?: boolean;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
};

function applyDataRoots(): void {
  const root =
    process.env.REPLAY_DATA_ROOT ||
    (process.env.VERCEL ? "/tmp/loop-replay-demo" : "./data/replay-demo");

  process.env.WORKING_DB_PATH =
    process.env.REPLAY_WORKING_DB_PATH || `${root}/working.sqlite`;
  process.env.EPISODIC_DB_PATH =
    process.env.REPLAY_EPISODIC_DB_PATH || `${root}/episodic.sqlite`;
  process.env.SEMANTIC_FALLBACK_PATH =
    process.env.REPLAY_SEMANTIC_FALLBACK_PATH ||
    `${root}/semantic_lessons.json`;
  process.env.PENDING_REFLECTION_DIR =
    process.env.REPLAY_PENDING_REFLECTION_DIR ||
    `${root}/pending_reflection`;
  process.env.REPLAY_TRAJECTORY_PATH =
    process.env.REPLAY_TRAJECTORY_PATH || `${root}/trajectory.json`;
}

async function prepareDemoStores(forceOffline = false): Promise<boolean> {
  applyDataRoots();

  // Strategy on for the full trajectory (seen runs teach; unseen retrieves).
  process.env.STRATEGY_INJECTION = process.env.STRATEGY_INJECTION || "1";
  // Raise direct-match confidence so differently worded unseen tasks use the
  // shared-factor retrieval path (lesson confidence after promotion is ~0.7).
  if (!process.env.STRATEGY_MIN_CONFIDENCE) {
    process.env.STRATEGY_MIN_CONFIDENCE = "0.95";
  }

  // Offline planner only when REPLAY_USE_OFFLINE=1 (or forceOffline for Vercel).
  const useOffline =
    forceOffline ||
    /^(1|true|yes|on)$/i.test(process.env.REPLAY_USE_OFFLINE || "0");
  if (useOffline) {
    process.env.REPLAY_USE_OFFLINE = "1";
    process.env.TENSORMUX_BASE_URL = "";
    process.env.TENSORMUX_API_KEY = "";
    // Hash-bow embeddings — no Ollama/localhost on serverless.
    process.env.EMBEDDING_BASE_URL = "";
    process.env.EMBEDDING_API_KEY = "";
    process.env.OLLAMA_BASE_URL = "";
  }

  const neatlogsOn = Boolean((process.env.NEATLOGS_API_KEY || "").trim());

  // Clean semantic store (Neo4j Aura labels and/or local JSON) for a fresh spine.
  await clearSemanticStore();
  console.log(
    JSON.stringify({
      type: "replay_demo_reset",
      store: semanticFallbackPath(),
      working_db: process.env.WORKING_DB_PATH,
      episodic_db: process.env.EPISODIC_DB_PATH,
      offline_planner: useOffline,
      neatlogs: neatlogsOn,
      neo4j: Boolean(
        (process.env.NEO4J_URI || "").trim() &&
          (process.env.NEO4J_USER || "").trim() &&
          (process.env.NEO4J_PASSWORD || "").trim(),
      ),
    }),
  );
  return useOffline;
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
    // Any HTTP response means tools are up (n8n workflows or Node mock).
    if (res.status < 100) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `CRM tools not reachable at ${base} (${msg}). Start n8n (npm run n8n:up) or mock (npm run tools).`,
    );
  }
}

/**
 * Run the seen_a → seen_b → unseen spine. Safe to call from the dashboard
 * (local spawn or Vercel in-process). Caller must ensure TOOLS_BASE_URL is up.
 */
export async function runReplayDemo(
  options: RunReplayDemoOptions = {},
): Promise<ReplayDemoResult> {
  const logs: Array<{ line: string; stream: "stdout" | "stderr" }> = [];
  const emit = (line: string, stream: "stdout" | "stderr" = "stdout") => {
    logs.push({ line, stream });
    options.onLog?.(line, stream);
  };

  const origLog = console.log;
  const origErr = console.error;
  let reentering = false;
  console.log = (...args: unknown[]) => {
    if (reentering) {
      origLog.apply(console, args as []);
      return;
    }
    reentering = true;
    try {
      const line = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      emit(line, "stdout");
      origLog.apply(console, args as []);
    } finally {
      reentering = false;
    }
  };
  console.error = (...args: unknown[]) => {
    if (reentering) {
      origErr.apply(console, args as []);
      return;
    }
    reentering = true;
    try {
      const line = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      emit(line, "stderr");
      origErr.apply(console, args as []);
    } finally {
      reentering = false;
    }
  };

  try {
    await prepareDemoStores(Boolean(options.forceOffline));
    await pingTools();
    await initObservability();

    const scenarios = loadScenarios();
    const rows: TrajectoryRow[] = [];

    try {
      console.log(
        JSON.stringify({
          type: "replay_demo_start",
          scenarios: scenarios.map((s) => ({ label: s.label, task: s.task })),
          note: "Uses runOnePlanner; mock tools required",
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

      const { rows: stampedRows, scorecard } = buildScorecardFromRows(rows);
      printAgentVersionScorecard(scorecard);

      const trajectoryPath = writeTrajectoryArtifact(stampedRows, scorecard);
      console.log(
        JSON.stringify({
          type: "replay_trajectory_written",
          path: trajectoryPath,
          row_count: stampedRows.length,
          scorecard_versions: scorecard.rows.map((r) => ({
            version: r.version,
            runs: r.run_count,
            task_success_rate: r.task_success_rate,
          })),
        }),
      );

      const seenA = stampedRows.find((r) => r.label === "seen_a")!;
      const seenB = stampedRows.find((r) => r.label === "seen_b")!;
      const unseen = stampedRows.find((r) => r.label === "unseen")!;

      const signals = evaluateImprovement(stampedRows);
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
      } else {
        console.log(
          JSON.stringify({
            type: "replay_demo_ok",
            signals_passed: signals.filter((s) => s.ok).map((s) => s.id),
          }),
        );
      }

      return {
        ok: anyOk,
        rows: stampedRows,
        trajectory_path: trajectoryPath,
        signals,
        exit_code: anyOk ? 0 : 1,
        scorecard,
      };
    } finally {
      await closeSemanticMemory();
      await shutdownObservability();
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function main(): Promise<void> {
  const result = await runReplayDemo();
  process.exitCode = result.exit_code;
}

// CLI only — dashboard imports runReplayDemo without executing main.
if (
  !process.env.VERCEL &&
  process.argv[1] &&
  /replay-demo\.(ts|js|mjs)$/.test(process.argv[1].replace(/\\/g, "/"))
) {
  main().catch(async (err) => {
    console.error(err);
    await closeSemanticMemory().catch(() => undefined);
    await shutdownObservability().catch(() => undefined);
    process.exit(1);
  });
}
