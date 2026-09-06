/**
 * Loop eval metrics — speed, latency, robustness, tokens, task success.
 * Stamped onto Neatlogs WORKFLOW output so detections/evals can score them.
 *
 * Also aggregates per-run metrics into an Agent v1 → v2 → v3 scorecard
 * bucketed by lesson-promotion boundaries (no new instrumentation).
 */

export type ToolCallLike = {
  name: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
  body?: unknown;
  args?: Record<string, unknown>;
};

export type LoopEvalMetrics = {
  /** Wall-clock run duration (ms) */
  latency_ms: number;
  /** Inverse latency score 0–1 (faster = higher). 10s → ~0.5 */
  speed_score: number;
  /** Fraction of tool calls that succeeded (0–1) */
  robustness_score: number;
  tool_call_count: number;
  tool_failure_count: number;
  /** Approx tokens when known (prompt+completion); else 0 */
  token_total: number;
  token_prompt: number;
  token_completion: number;
  /** 1 when latency exceeds threshold vs soft budget */
  latency_flag: boolean;
  /** 1 when robustness < 1 */
  robustness_flag: boolean;
  /** Drift cues from this run (analyzer-aligned labels) */
  drift_signals: string[];
  /**
   * Task-level success for CRM teaching demos:
   * no failed/unscoped list_orders AND at least one scoped list_orders ok.
   */
  task_success: boolean;
};

function toolFailed(c: ToolCallLike): boolean {
  if (c.ok === false) return true;
  if (c.status > 0 && (c.status < 200 || c.status >= 300)) return true;
  if (c.error && String(c.error).trim()) return true;
  const body = c.body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.ok === false) return true;
    if (b.unscoped === true) return true;
    if (typeof b.error === "string" && b.error.trim()) return true;
  }
  return false;
}

function isFailedOrUnscopedListOrders(c: ToolCallLike): boolean {
  if (c.name !== "list_orders") return false;
  const hasId = Boolean(c.args?.customer_id);
  if (!hasId) return true;
  if (toolFailed(c)) return true;
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

/** CRM demo task success — shared by planner metrics + replay scorecard. */
export function computeTaskSuccess(toolCalls: ToolCallLike[]): boolean {
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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Soft speed score: half-life at `halfLifeMs` (default 10s).
 * score = 1 / (1 + latency/halfLife)
 */
export function computeSpeedScore(
  latencyMs: number,
  halfLifeMs = 10_000,
): number {
  return clamp01(1 / (1 + Math.max(0, latencyMs) / halfLifeMs));
}

export function computeLoopEvalMetrics(params: {
  latencyMs: number;
  toolCalls: ToolCallLike[];
  tokenPrompt?: number;
  tokenCompletion?: number;
  /** Soft budget for latency_flag (ms) */
  latencyBudgetMs?: number;
  analyzerTriggers?: string[];
}): LoopEvalMetrics {
  const budget = params.latencyBudgetMs ?? 8_000;
  const failures = params.toolCalls.filter(toolFailed);
  const total = params.toolCalls.length;
  const robustness =
    total === 0
      ? params.analyzerTriggers?.length
        ? 0.5
        : 1
      : (total - failures.length) / total;

  const drift = new Set<string>();
  for (const t of params.analyzerTriggers || []) {
    drift.add(t);
  }
  for (const c of params.toolCalls) {
    const blob = JSON.stringify(c.body ?? "").toLowerCase();
    if (blob.includes("missing_customer_id")) drift.add("missing_customer_id");
    if (blob.includes('"unscoped":true') || blob.includes('"unscoped": true')) {
      drift.add("unscoped_tool");
    }
  }
  // duplicate / retry heuristics
  const names = params.toolCalls.map((c) => c.name);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) drift.add("duplicate_or_retry_tool");
    seen.add(n);
  }

  const prompt = Number(params.tokenPrompt || 0);
  const completion = Number(params.tokenCompletion || 0);

  return {
    latency_ms: Math.round(params.latencyMs),
    speed_score: Number(computeSpeedScore(params.latencyMs).toFixed(3)),
    robustness_score: Number(clamp01(robustness).toFixed(3)),
    tool_call_count: total,
    tool_failure_count: failures.length,
    token_total: prompt + completion,
    token_prompt: prompt,
    token_completion: completion,
    latency_flag: params.latencyMs > budget,
    robustness_flag: robustness < 1,
    drift_signals: [...drift],
    task_success: computeTaskSuccess(params.toolCalls),
  };
}

/** Compact blob for Neatlogs setTraceOutput / regex detections. */
export function formatEvalMetricsForTrace(
  m: LoopEvalMetrics,
): Record<string, unknown> {
  return {
    loop_eval: true,
    product: "loop",
    latency_ms: m.latency_ms,
    speed_score: m.speed_score,
    robustness_score: m.robustness_score,
    token_total: m.token_total,
    token_prompt: m.token_prompt,
    token_completion: m.token_completion,
    latency_flag: m.latency_flag,
    robustness_flag: m.robustness_flag,
    drift_signals: m.drift_signals,
    analyzer_triggers: m.drift_signals,
    task_success: m.task_success,
  };
}

// ---------------------------------------------------------------------------
// Agent v1 → v2 → v3 scorecard (lesson-promotion boundaries)
// ---------------------------------------------------------------------------

export type AgentVersion = "v1" | "v2" | "v3";

export type EvalRunForScorecard = {
  run_id: string;
  /** Optional scenario label (seen_a / seen_b / unseen) */
  label?: string | null;
  /** Reflection outcome for this run */
  reflection_status?: "promoted" | "candidate" | "skipped" | "failed" | null;
  lessons_promoted?: string[];
  lessons_retrieved?: number;
  first_tool?: string | null;
  metrics: LoopEvalMetrics;
};

export type AgentVersionScorecardRow = {
  version: AgentVersion;
  /** Human label for the brief's Agent v1 → v2 → v3 story */
  title: string;
  boundary: string;
  run_count: number;
  run_ids: string[];
  labels: string[];
  task_success_rate: number;
  avg_speed_score: number;
  avg_robustness_score: number;
  avg_latency_ms: number;
  avg_token_total: number;
  avg_tool_failure_count: number;
  drift_rate: number;
  dominant_first_tool: string | null;
};

export type AgentVersionScorecard = {
  type: "agent_version_scorecard";
  /** How buckets were assigned */
  bucketing: "lesson_promotion_boundaries";
  note: string;
  rows: AgentVersionScorecardRow[];
  /** Flat comparison for dashboards / Neatlogs writeups */
  comparison: Record<
    AgentVersion,
    {
      title: string;
      task_success_rate: number;
      avg_speed_score: number;
      avg_robustness_score: number;
      avg_latency_ms: number;
      run_count: number;
    }
  >;
};

const VERSION_META: Record<
  AgentVersion,
  { title: string; boundary: string }
> = {
  v1: {
    title: "Agent v1 — naive (pre-lesson)",
    boundary: "before first usable lesson promotion",
  },
  v2: {
    title: "Agent v2 — promotion run",
    boundary: "run that promotes a usable lesson (evidence gate)",
  },
  v3: {
    title: "Agent v3 — post-lesson",
    boundary: "after promotion (lesson injectable / retrieved)",
  },
};

/**
 * Assign each ordered run to v1 / v2 / v3 using the first promotion event
 * as the boundary (lessons_promoted nonempty OR reflection_status=promoted).
 */
export function assignAgentVersions(
  runs: EvalRunForScorecard[],
): Array<EvalRunForScorecard & { version: AgentVersion }> {
  const promoteIdx = runs.findIndex(
    (r) =>
      r.reflection_status === "promoted" ||
      (Array.isArray(r.lessons_promoted) && r.lessons_promoted.length > 0),
  );

  return runs.map((r, i) => {
    let version: AgentVersion;
    if (promoteIdx < 0) {
      version = "v1";
    } else if (i < promoteIdx) {
      version = "v1";
    } else if (i === promoteIdx) {
      version = "v2";
    } else {
      version = "v3";
    }
    return { ...r, version };
  });
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function avgFixed(nums: number[], digits = 3): number {
  return Number(avg(nums).toFixed(digits));
}

function modeString(vals: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of vals) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function emptyRow(version: AgentVersion): AgentVersionScorecardRow {
  const meta = VERSION_META[version];
  return {
    version,
    title: meta.title,
    boundary: meta.boundary,
    run_count: 0,
    run_ids: [],
    labels: [],
    task_success_rate: 0,
    avg_speed_score: 0,
    avg_robustness_score: 0,
    avg_latency_ms: 0,
    avg_token_total: 0,
    avg_tool_failure_count: 0,
    drift_rate: 0,
    dominant_first_tool: null,
  };
}

function aggregateBucket(
  version: AgentVersion,
  runs: Array<EvalRunForScorecard & { version: AgentVersion }>,
): AgentVersionScorecardRow {
  const bucket = runs.filter((r) => r.version === version);
  if (bucket.length === 0) return emptyRow(version);
  const meta = VERSION_META[version];
  const successN = bucket.filter((r) => r.metrics.task_success).length;
  const driftN = bucket.filter((r) => r.metrics.drift_signals.length > 0).length;
  return {
    version,
    title: meta.title,
    boundary: meta.boundary,
    run_count: bucket.length,
    run_ids: bucket.map((r) => r.run_id),
    labels: bucket.map((r) => r.label || r.run_id),
    task_success_rate: Number((successN / bucket.length).toFixed(3)),
    avg_speed_score: avgFixed(bucket.map((r) => r.metrics.speed_score)),
    avg_robustness_score: avgFixed(
      bucket.map((r) => r.metrics.robustness_score),
    ),
    avg_latency_ms: Math.round(avg(bucket.map((r) => r.metrics.latency_ms))),
    avg_token_total: Math.round(avg(bucket.map((r) => r.metrics.token_total))),
    avg_tool_failure_count: avgFixed(
      bucket.map((r) => r.metrics.tool_failure_count),
      2,
    ),
    drift_rate: Number((driftN / bucket.length).toFixed(3)),
    dominant_first_tool: modeString(bucket.map((r) => r.first_tool)),
  };
}

/**
 * Build the Agent v1 → v2 → v3 comparative scorecard from existing per-run
 * evalMetrics + promotion markers. Ordered runs required.
 */
export function buildAgentVersionScorecard(
  runs: EvalRunForScorecard[],
): AgentVersionScorecard {
  const assigned = assignAgentVersions(runs);
  const rows: AgentVersionScorecardRow[] = [
    aggregateBucket("v1", assigned),
    aggregateBucket("v2", assigned),
    aggregateBucket("v3", assigned),
  ];

  const comparison = {
    v1: {
      title: rows[0].title,
      task_success_rate: rows[0].task_success_rate,
      avg_speed_score: rows[0].avg_speed_score,
      avg_robustness_score: rows[0].avg_robustness_score,
      avg_latency_ms: rows[0].avg_latency_ms,
      run_count: rows[0].run_count,
    },
    v2: {
      title: rows[1].title,
      task_success_rate: rows[1].task_success_rate,
      avg_speed_score: rows[1].avg_speed_score,
      avg_robustness_score: rows[1].avg_robustness_score,
      avg_latency_ms: rows[1].avg_latency_ms,
      run_count: rows[1].run_count,
    },
    v3: {
      title: rows[2].title,
      task_success_rate: rows[2].task_success_rate,
      avg_speed_score: rows[2].avg_speed_score,
      avg_robustness_score: rows[2].avg_robustness_score,
      avg_latency_ms: rows[2].avg_latency_ms,
      run_count: rows[2].run_count,
    },
  };

  return {
    type: "agent_version_scorecard",
    bucketing: "lesson_promotion_boundaries",
    note: "Buckets existing loop_eval metrics by the first usable-lesson promotion (v1 before, v2 promoting run, v3 after). No new instrumentation.",
    rows,
    comparison,
  };
}

/** ASCII / markdown-friendly table for stdout demos. */
export function formatAgentVersionScorecardTable(
  scorecard: AgentVersionScorecard,
): string {
  const pad = (s: string, n: number) =>
    s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
  const header = [
    pad("ver", 4),
    pad("runs", 5),
    pad("success", 8),
    pad("speed", 7),
    pad("robust", 7),
    pad("lat_ms", 8),
    pad("fail_avg", 8),
    pad("drift", 6),
    pad("first_tool", 16),
    "title",
  ].join(" ");
  const lines = [header, "-".repeat(header.length)];
  for (const r of scorecard.rows) {
    lines.push(
      [
        pad(r.version, 4),
        pad(String(r.run_count), 5),
        pad(r.task_success_rate.toFixed(2), 8),
        pad(r.avg_speed_score.toFixed(3), 7),
        pad(r.avg_robustness_score.toFixed(3), 7),
        pad(String(r.avg_latency_ms), 8),
        pad(r.avg_tool_failure_count.toFixed(2), 8),
        pad(r.drift_rate.toFixed(2), 6),
        pad(r.dominant_first_tool || "-", 16),
        r.title,
      ].join(" "),
    );
  }
  return lines.join("\n");
}
