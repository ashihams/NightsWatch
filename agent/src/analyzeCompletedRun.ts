/**
 * Build AnalyzeRunInput: prefer Neatlogs session/trace when NEATLOGS_* set;
 * fall back to working-memory tool_call_log + in-memory run summary.
 *
 * Merges Neatlogs eval detections into analyzer triggers when the MCP path hits.
 */

import {
  analyzeRun,
  normalizeToolCallLogEntry,
  type AnalyzeRunInput,
  type AnalyzeRunResult,
  type NormalizedToolCall,
  type PriorEpisodeSummary,
} from "./analyzer.js";
import { listEpisodes } from "./episodicMemory.js";
import {
  detectionNamesToTriggers,
  tryLoadNeatlogsToolCalls,
} from "./neatlogsSession.js";
import { getWorkingRun } from "./workingMemory.js";
import type { ToolCallResult } from "./tools.js";

function fromToolCallResult(c: ToolCallResult): NormalizedToolCall {
  return {
    name: c.name,
    args: c.args,
    status: c.status,
    ok: c.ok,
    latencyMs: c.latencyMs,
    body: c.body,
  };
}

function priorEpisodesExcluding(runId: string): PriorEpisodeSummary[] {
  return listEpisodes(50)
    .filter((ep) => ep.run_id !== runId)
    .map((ep) => ({
      run_id: ep.run_id,
      tool_sequence: ep.tool_sequence,
      latency_ms: ep.latency_ms,
      success: ep.success,
      situation_summary: ep.situation_summary,
    }));
}

export type PostRunAnalysis = {
  source: "neatlogs" | "working_memory";
  analysis: AnalyzeRunResult;
  input: AnalyzeRunInput;
};

/**
 * Load tool-call evidence (Neatlogs preferred) and run the pure analyzer.
 * Caller must flush Neatlogs before this when tracing is enabled.
 */
export async function analyzeCompletedRun(params: {
  runId: string;
  task: string;
  toolCalls: ToolCallResult[];
  latencyMs: number;
  success: boolean;
}): Promise<PostRunAnalysis> {
  const prior = priorEpisodesExcluding(params.runId);

  const neat = await tryLoadNeatlogsToolCalls({
    runId: params.runId,
    task: params.task,
    toolCalls: params.toolCalls.map((c) => ({
      name: c.name,
      args: c.args,
      status: c.status,
      ok: c.ok,
      latencyMs: c.latencyMs,
      body: c.body,
    })),
    latencyMs: params.latencyMs,
    success: params.success,
  });

  if (neat && neat.toolCalls.length > 0) {
    const input: AnalyzeRunInput = {
      runId: params.runId,
      task: params.task,
      toolCalls: neat.toolCalls,
      latencyMs: neat.latencyMs ?? params.latencyMs,
      success: params.success,
      priorEpisodes: prior,
      source: "neatlogs",
      neatlogs: {
        trace_id: neat.traceId,
        search_query: neat.searchQuery,
        llm_spans: neat.llmSpans,
        detections: neat.detections,
        project_detections: neat.projectDetections,
        tensormux_requests: neat.tensormuxRequests,
        extra_triggers: detectionNamesToTriggers(neat.detections),
      },
    };
    const analysis = analyzeRun(input);
    console.log(
      JSON.stringify({
        type: "analyzer_source",
        run_id: params.runId,
        source: "neatlogs",
        trace_id: neat.traceId,
        tool_call_count: neat.toolCalls.length,
        detection_triggers: input.neatlogs?.extra_triggers,
      }),
    );
    return { source: "neatlogs", analysis, input };
  }

  // Fallback: working-memory log, then in-memory toolCalls from this run
  let toolCalls: NormalizedToolCall[] = [];
  try {
    const row = getWorkingRun(params.runId);
    if (row) {
      toolCalls = row.tool_call_log
        .map(normalizeToolCallLogEntry)
        .filter((c): c is NormalizedToolCall => c !== null);
    }
  } catch {
    // ignore — use in-memory
  }

  if (toolCalls.length === 0) {
    toolCalls = params.toolCalls.map(fromToolCallResult);
  }

  const input: AnalyzeRunInput = {
    runId: params.runId,
    task: params.task,
    toolCalls,
    latencyMs: params.latencyMs,
    success: params.success,
    priorEpisodes: prior,
    source: "working_memory",
  };

  console.log(
    JSON.stringify({
      type: "analyzer_source",
      run_id: params.runId,
      source: "working_memory",
      note:
        (process.env.NEATLOGS_API_KEY || "").trim()
          ? "neatlogs unavailable or empty — using working_memory tool_call_log"
          : "NEATLOGS_API_KEY unset — using working_memory tool_call_log",
      tool_call_count: toolCalls.length,
    }),
  );

  return { source: "working_memory", analysis: analyzeRun(input), input };
}
