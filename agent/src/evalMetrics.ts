/**
 * Loop eval metrics — speed, latency, robustness, tokens.
 * Stamped onto Neatlogs WORKFLOW output so detections/evals can score them.
 */

export type ToolCallLike = {
  name: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
  body?: unknown;
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
    total === 0 ? (params.analyzerTriggers?.length ? 0.5 : 1) : (total - failures.length) / total;

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
  };
}

/** Compact blob for Neatlogs setTraceOutput / regex detections. */
export function formatEvalMetricsForTrace(m: LoopEvalMetrics): Record<string, unknown> {
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
  };
}
