/**
 * Deterministic post-run analyzer (no LLM).
 *
 * Pure function: analyzeRun(input) → { flagged, triggers, evidence }.
 * Callers load tool-call data from Neatlogs (preferred) or working-memory
 * fallback, then pass a normalized AnalyzeRunInput here.
 */

export type NormalizedToolCall = {
  name: string;
  args: Record<string, unknown>;
  status: number;
  ok: boolean;
  latencyMs: number;
  body?: unknown;
  error?: string;
};

export type PriorEpisodeSummary = {
  run_id?: string;
  tool_sequence: string[];
  latency_ms: number;
  success: boolean;
  situation_summary?: string;
};

export type AnalyzeRunInput = {
  runId: string;
  task: string;
  toolCalls: NormalizedToolCall[];
  /** Wall-clock run duration in ms */
  latencyMs: number;
  success: boolean;
  /** Prior episodes (exclude the current run) for latency + sequence baselines */
  priorEpisodes: PriorEpisodeSummary[];
  /** Which path produced toolCalls */
  source: "neatlogs" | "working_memory";
};

export type AnalyzeRunResult = {
  flagged: boolean;
  triggers: string[];
  evidence: Record<string, unknown>;
};

/** Stable fingerprint for "same effective inputs". */
export function effectiveInputKey(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}::${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function hasExplicitError(call: NormalizedToolCall): boolean {
  if (call.error && String(call.error).trim()) return true;
  const body = call.body;
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.ok === false) return true;
  if (typeof b.error === "string" && b.error.trim()) return true;
  // Intentional mock CRM teaching miss: unscoped orders without customer_id
  if (b.unscoped === true) return true;
  return false;
}

function isToolFailure(call: NormalizedToolCall): boolean {
  if (call.ok === false) return true;
  if (call.status > 0 && (call.status < 200 || call.status >= 300)) return true;
  if (hasExplicitError(call)) return true;
  return false;
}

function sequenceKey(seq: string[]): string {
  return seq.join("→");
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** Token overlap heuristic for "similar task type". */
function similarTask(
  task: string,
  episode: PriorEpisodeSummary,
): boolean {
  const taskTokens = new Set(
    task
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
  if (taskTokens.size === 0) return true;
  const hay = `${episode.situation_summary || ""} ${episode.tool_sequence.join(" ")}`.toLowerCase();
  let hits = 0;
  for (const t of taskTokens) {
    if (hay.includes(t)) hits += 1;
  }
  // At least one meaningful overlap, or treat as similar when episode has no summary
  if (!episode.situation_summary) return true;
  return hits >= 1;
}

/**
 * Pure analyzer — flag if any fixed trigger fires.
 *
 * Triggers:
 * - tool_failure
 * - retry
 * - duplicate_tool_call
 * - high_latency (skipped with no prior baseline)
 * - novel_tool_sequence (only when prior successful history exists)
 */
export function analyzeRun(input: AnalyzeRunInput): AnalyzeRunResult {
  const triggers: string[] = [];
  const evidence: Record<string, unknown> = {
    run_id: input.runId,
    source: input.source,
    tool_call_count: input.toolCalls.length,
    run_latency_ms: input.latencyMs,
    success: input.success,
  };

  // --- tool_failure ---
  const failures = input.toolCalls
    .map((c, i) => ({ index: i, call: c }))
    .filter(({ call }) => isToolFailure(call));
  if (failures.length > 0) {
    triggers.push("tool_failure");
    evidence.tool_failure = failures.map(({ index, call }) => ({
      index,
      name: call.name,
      status: call.status,
      ok: call.ok,
      error:
        call.error ||
        (call.body &&
        typeof call.body === "object" &&
        (call.body as { error?: string }).error
          ? (call.body as { error?: string }).error
          : undefined),
      args: call.args,
    }));
  }

  // --- retry: same tool again after a failure (any args), or duplicate attempt after fail ---
  const retries: Array<Record<string, unknown>> = [];
  const failedNames = new Set<string>();
  for (let i = 0; i < input.toolCalls.length; i++) {
    const call = input.toolCalls[i];
    if (failedNames.has(call.name)) {
      retries.push({
        index: i,
        name: call.name,
        reason: "same_tool_after_failure",
        args: call.args,
      });
    }
    if (isToolFailure(call)) {
      failedNames.add(call.name);
    }
  }
  if (retries.length > 0) {
    triggers.push("retry");
    evidence.retry = retries;
  }

  // --- duplicate_tool_call: same tool + same effective inputs ---
  const seen = new Map<string, number>();
  const duplicates: Array<Record<string, unknown>> = [];
  for (let i = 0; i < input.toolCalls.length; i++) {
    const call = input.toolCalls[i];
    const key = effectiveInputKey(call.name, call.args || {});
    const first = seen.get(key);
    if (first !== undefined) {
      duplicates.push({
        index: i,
        first_index: first,
        name: call.name,
        args: call.args,
      });
    } else {
      seen.set(key, i);
    }
  }
  if (duplicates.length > 0) {
    triggers.push("duplicate_tool_call");
    evidence.duplicate_tool_call = duplicates;
  }

  // --- high_latency vs prior similar runs ---
  const baselineCandidates = input.priorEpisodes.filter(
    (ep) => ep.latency_ms > 0 && similarTask(input.task, ep),
  );
  if (baselineCandidates.length === 0) {
    evidence.high_latency = { skipped: true, reason: "no_prior_baseline" };
  } else {
    const baselineMs = median(baselineCandidates.map((e) => e.latency_ms));
    const threshold = Math.max(baselineMs * 2, baselineMs + 500);
    const high = input.latencyMs > threshold;
    evidence.high_latency = {
      skipped: false,
      baseline_median_ms: Math.round(baselineMs),
      threshold_ms: Math.round(threshold),
      run_latency_ms: input.latencyMs,
      prior_count: baselineCandidates.length,
      triggered: high,
    };
    if (high) {
      triggers.push("high_latency");
    }
  }

  // --- novel_tool_sequence: successful sequence not seen in prior successful history ---
  const currentSeq = input.toolCalls.map((c) => c.name);
  const priorSuccessSeqs = input.priorEpisodes
    .filter((ep) => ep.success && ep.tool_sequence.length > 0)
    .map((ep) => sequenceKey(ep.tool_sequence));
  if (priorSuccessSeqs.length === 0) {
    evidence.novel_tool_sequence = {
      skipped: true,
      reason: "no_prior_successful_sequences",
      current_sequence: currentSeq,
    };
  } else if (input.success && currentSeq.length > 0) {
    const key = sequenceKey(currentSeq);
    const novel = !priorSuccessSeqs.includes(key);
    evidence.novel_tool_sequence = {
      skipped: false,
      current_sequence: currentSeq,
      known_sequences: [...new Set(priorSuccessSeqs)],
      triggered: novel,
    };
    if (novel) {
      triggers.push("novel_tool_sequence");
    }
  } else {
    evidence.novel_tool_sequence = {
      skipped: true,
      reason: input.success ? "empty_sequence" : "run_not_successful",
      current_sequence: currentSeq,
    };
  }

  return {
    flagged: triggers.length > 0,
    triggers,
    evidence,
  };
}

/** Normalize a working-memory / in-memory tool call log entry. */
export function normalizeToolCallLogEntry(
  entry: unknown,
): NormalizedToolCall | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const name = String(e.name || "");
  if (!name) return null;
  const args =
    e.args && typeof e.args === "object" && !Array.isArray(e.args)
      ? (e.args as Record<string, unknown>)
      : {};
  const status = Number(e.status ?? 0);
  const ok = Boolean(e.ok);
  const latencyMs = Number(e.latency_ms ?? e.latencyMs ?? 0);
  return {
    name,
    args,
    status,
    ok,
    latencyMs,
    body: e.body,
    error: typeof e.error === "string" ? e.error : undefined,
  };
}
