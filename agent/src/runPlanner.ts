/**
 * One planner run — clear AO session entrypoint.
 *
 * Wrap `runOnePlanner(task)` as an AO session later; keep this function the
 * single unit of "agent work" for a natural-language task.
 *
 * Working memory (SQLite): one row per run — start → append tool calls → complete|failed.
 * Strategy (Step 8): retrieve usable semantic lessons at start → inject into planner.
 * Episodic memory (SQLite vectors): fallback soft context when no strong semantic hit.
 * Post-run: deterministic analyzer → reflection LLM (if flagged) → semantic memory evidence gate.
 */

import {
  assistantToolStub,
  planNextStep,
  tensormuxConfigured,
  toolResultMessage,
  type LlmMessage,
} from "./llm.js";
import { offlinePlanNext } from "./offlinePlanner.js";
import { flushObservability, withPlannerWorkflow } from "./observability.js";
import { TOOL_NAMES, callTool, type ToolCallResult, type ToolName } from "./tools.js";
import {
  appendToolCall,
  finishWorkingRun,
  getInjectedContext,
  getWorkingRun,
  hasSemanticLessons,
  setInjectedContext,
  startWorkingRun,
} from "./workingMemory.js";
import {
  buildSituationSummary,
  episodesToInjectedContext,
  retrieveEpisodes,
  writeEpisode,
} from "./episodicMemory.js";
import { analyzeCompletedRun } from "./analyzeCompletedRun.js";
import {
  markPendingReflectionDone,
  writePendingReflection,
} from "./pendingReflection.js";
import { reflectOnFlaggedRun } from "./reflection.js";
import {
  storeCandidateLesson,
  type StoreLessonResult,
} from "./semanticMemory.js";
import {
  formatLessonsForPrompt,
  getInjectedSemanticLessons,
  lessonsToInjectedContext,
  retrieveStrategyLessons,
  strategyInjectionEnabled,
} from "./strategy.js";
import type { AnalyzeRunResult, NormalizedToolCall } from "./analyzer.js";
import {
  computeLoopEvalMetrics,
  formatEvalMetricsForTrace,
} from "./evalMetrics.js";

export type PlannerRunResult = {
  task: string;
  mode: "tensormux" | "offline";
  runId: string;
  steps: number;
  toolCalls: ToolCallResult[];
  finalMessage: string;
  analysis?: AnalyzeRunResult;
  analysisSource?: "neatlogs" | "working_memory";
  reflection?: StoreLessonResult;
  /** Per-run loop_eval blob (includes task_success). */
  evalMetrics?: Record<string, unknown>;
};

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function maxSteps(): number {
  const n = Number(process.env.AGENT_MAX_STEPS || 8);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

function retrieveK(): number {
  const n = Number(process.env.EPISODIC_RETRIEVE_K || 3);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/**
 * Step 8: query usable semantic lessons first (direct or shared-factor).
 * Writes semantic_lesson entries into working_runs.injected_context when strong enough.
 */
async function maybeInjectStrategyLessons(
  runId: string,
  task: string,
): Promise<void> {
  if (!strategyInjectionEnabled()) {
    console.log(
      JSON.stringify({
        type: "strategy_inject",
        run_id: runId,
        enabled: false,
        note: "STRATEGY_INJECTION disabled",
      }),
    );
    return;
  }

  // Soft prior episode blurbs help factor extraction without injecting them yet.
  const priorMatches = await retrieveEpisodes(task, retrieveK());
  const priorSummaries = priorMatches.map((m) => m.situation_summary);

  const retrieval = await retrieveStrategyLessons({
    task,
    priorEpisodeSummaries: priorSummaries,
  });

  console.log(
    JSON.stringify({
      type: "strategy_factors",
      run_id: runId,
      factors: retrieval.factors.factors,
      factor_evidence: retrieval.factors.evidence,
      query_factors: retrieval.query_factors,
    }),
  );

  if (retrieval.path === "none" || retrieval.lessons.length === 0) {
    console.log(
      JSON.stringify({
        type: "strategy_inject",
        run_id: runId,
        path: "none",
        injected: 0,
        note: "no usable lessons matched; episodic fallback may run",
      }),
    );
    return;
  }

  const soft = lessonsToInjectedContext(retrieval);
  const existing = getInjectedContext(runId);
  const kept = existing.filter(
    (item) =>
      !(
        item !== null &&
        typeof item === "object" &&
        (item as { type?: string }).type === "semantic_lesson"
      ),
  );
  setInjectedContext(runId, [...kept, ...soft]);

  console.log(
    JSON.stringify({
      type: "strategy_inject",
      run_id: runId,
      path: retrieval.path,
      injected: soft.length,
      min_confidence: retrieval.min_confidence,
      lessons: soft.map((l) => ({
        id: l.lesson_id,
        text: l.text,
        confidence: l.confidence,
        evidence_count: l.evidence_count,
        retrieval_path: l.retrieval_path,
        shared_factor_count: l.shared_factor_count,
        matched_factors: l.matched_factors,
      })),
    }),
  );
}

async function maybeInjectEpisodicContext(
  runId: string,
  task: string,
): Promise<void> {
  const existing = getInjectedContext(runId);
  if (hasSemanticLessons(existing)) {
    console.log(
      JSON.stringify({
        type: "episodic_skip",
        run_id: runId,
        reason: "injected_context already has semantic_lesson entries",
      }),
    );
    return;
  }

  const matches = await retrieveEpisodes(task, retrieveK());
  if (matches.length === 0) {
    console.log(
      JSON.stringify({
        type: "episodic_inject",
        run_id: runId,
        injected: 0,
        note: "no prior episodes yet",
      }),
    );
    return;
  }

  const soft = episodesToInjectedContext(matches);
  // Keep any non-lesson entries; replace prior episodic soft context.
  const kept = existing.filter(
    (item) =>
      !(
        item !== null &&
        typeof item === "object" &&
        (item as { type?: string }).type === "episodic"
      ),
  );
  setInjectedContext(runId, [...kept, ...soft]);

  console.log(
    JSON.stringify({
      type: "episodic_inject",
      run_id: runId,
      injected: soft.length,
      retrieved_run_ids: soft.map((s) => s.run_id),
      summaries: soft.map((s) => s.situation_summary),
    }),
  );
}

async function persistEpisode(params: {
  runId: string;
  task: string;
  toolCalls: ToolCallResult[];
  success: boolean;
  latencyMs: number;
}): Promise<void> {
  const toolSequence = params.toolCalls.map((c) => c.name);
  const situation = buildSituationSummary(
    params.task,
    toolSequence,
    params.success,
  );
  await writeEpisode({
    run_id: params.runId,
    situation_summary: situation,
    tool_sequence: toolSequence,
    success: params.success,
    tool_call_count: params.toolCalls.length,
    token_count: 0,
    latency_ms: params.latencyMs,
  });
}

/**
 * Always run the deterministic analyzer after a run ends.
 * If flagged: reflect (TensorMux or offline) → store candidate / promote via evidence gate.
 */
async function runPostAnalyzer(params: {
  runId: string;
  task: string;
  toolCalls: ToolCallResult[];
  latencyMs: number;
  success: boolean;
  mode: string;
  finalMessage: string;
}): Promise<{
  analysis: AnalyzeRunResult;
  source: "neatlogs" | "working_memory";
  reflection?: StoreLessonResult;
}> {
  const { analysis, source, input } = await analyzeCompletedRun({
    runId: params.runId,
    task: params.task,
    toolCalls: params.toolCalls,
    latencyMs: params.latencyMs,
    success: params.success,
  });

  console.log(
    JSON.stringify({
      type: "analyzer_result",
      run_id: params.runId,
      source,
      flagged: analysis.flagged,
      triggers: analysis.triggers,
      evidence_keys: Object.keys(analysis.evidence),
    }),
  );

  if (!analysis.flagged) {
    return { analysis, source };
  }

  console.log(
    JSON.stringify({
      type: "reflection_gate",
      run_id: params.runId,
      stage: "flagged",
      triggers: analysis.triggers,
    }),
  );

  const pendingPath = writePendingReflection({
    runId: params.runId,
    task: params.task,
    source,
    analysis,
    mode: params.mode,
    finalMessage: params.finalMessage,
  });

  let toolCalls: NormalizedToolCall[] = input.toolCalls;
  if (toolCalls.length === 0) {
    toolCalls = params.toolCalls.map((c) => ({
      name: c.name,
      args: c.args,
      status: c.status,
      ok: c.ok,
      latencyMs: c.latencyMs,
      body: c.body,
    }));
  }

  let reflection: StoreLessonResult | undefined;
  try {
    const candidate = await reflectOnFlaggedRun({
      runId: params.runId,
      task: params.task,
      analysis,
      toolCalls,
    });

    console.log(
      JSON.stringify({
        type: "reflection_result",
        run_id: params.runId,
        stage: "reflected",
        mode: candidate.mode,
        tool: candidate.tool,
        factors: candidate.factors,
        lesson_id: candidate.lesson_id,
        lesson_text: candidate.lesson_text,
      }),
    );

    const working = getWorkingRun(params.runId);
    reflection = await storeCandidateLesson({
      run: {
        id: params.runId,
        task: params.task,
        started_at: working?.started_at || new Date().toISOString(),
        success: params.success,
        tool_calls: params.toolCalls.length,
        tokens: 0,
        latency_ms: params.latencyMs,
      },
      candidate,
    });

    const status = reflection.lesson.usable ? "promoted" : "candidate";
    console.log(
      JSON.stringify({
        type: "semantic_memory_upsert",
        run_id: params.runId,
        stage: status,
        lesson_id: reflection.lesson.id,
        evidence_count: reflection.lesson.evidence_count,
        confidence: reflection.lesson.confidence,
        usable: reflection.lesson.usable,
        promoted_this_run: reflection.promoted,
        backend: reflection.backend,
        supporting_run_ids: reflection.lesson.supporting_run_ids,
        pending_path: pendingPath,
      }),
    );

    markPendingReflectionDone({
      runId: params.runId,
      lessonId: reflection.lesson.id,
      evidenceCount: reflection.lesson.evidence_count,
      usable: reflection.lesson.usable,
    });
  } catch (err) {
    console.warn(
      "[reflection] failed — pending_reflection kept; agent continues:",
      err instanceof Error ? err.message : err,
    );
    console.log(
      JSON.stringify({
        type: "pending_reflection",
        run_id: params.runId,
        path: pendingPath,
        triggers: analysis.triggers,
        note: "reflection failed; record left pending",
      }),
    );
  }

  return { analysis, source, reflection };
}

/**
 * Run a single planner loop for `task`.
 * Routes LLM planning through TensorMux when configured; otherwise offline naive planner.
 *
 * Trace lifecycle (Neatlogs docs): WORKFLOW root ends → flush → MCP search_traces
 * for analyzer read-back. Analyzer must NOT run inside the open WORKFLOW span.
 *
 * This is the AO-session entrypoint — wrap later as an AO session; keep the boundary here.
 */
export async function runOnePlanner(task: string): Promise<PlannerRunResult> {
  const mode = tensormuxConfigured() ? "tensormux" : "offline";
  const toolCalls: ToolCallResult[] = [];
  const history: LlmMessage[] = [];
  const limit = maxSteps();
  const runStarted = Date.now();
  const runId = startWorkingRun(task);

  console.log(
    JSON.stringify({
      type: "planner_start",
      run_id: runId,
      task,
      mode,
      max_steps: limit,
    }),
  );

  type CoreResult = {
    finalMessage: string;
    runStatus: "complete" | "failed";
    latencyMs: number;
    evalMetrics?: Record<string, unknown>;
  };

  let core: CoreResult;

  try {
    core = await withPlannerWorkflow({ runId, task, mode }, async (_meta) => {
      // Semantic lessons first; episodic only when nothing strong was injected.
      await maybeInjectStrategyLessons(runId, task);
      await maybeInjectEpisodicContext(runId, task);

      const injected = getInjectedContext(runId);
      const semanticLessons = getInjectedSemanticLessons(injected);
      const lessonBlock = formatLessonsForPrompt(semanticLessons);

      let finalMessage = "";
      let runStatus: "complete" | "failed" = "complete";

      for (let step = 0; step < limit; step++) {
        const action =
          mode === "tensormux"
            ? await planNextStep(task, history, lessonBlock)
            : offlinePlanNext(task, toolCalls, injected);

        if (action.type === "finish") {
          finalMessage = action.message;
          break;
        }

        if (!isToolName(action.name)) {
          finalMessage = `Unknown tool "${action.name}"; stopping.`;
          runStatus = "failed";
          break;
        }

        const callId = `call_${step + 1}`;
        if (mode === "tensormux") {
          history.push(assistantToolStub(action.name, action.args, callId));
        }

        const result = await callTool(action.name, action.args);
        toolCalls.push(result);
        appendToolCall(runId, result);

        if (mode === "tensormux") {
          history.push(
            toolResultMessage(callId, {
              status: result.status,
              body: result.body,
            }),
          );
        }
      }

      if (!finalMessage) {
        finalMessage = `Stopped after ${limit} steps.`;
      }

      finishWorkingRun(runId, runStatus);
      const latencyMs = Date.now() - runStarted;
      await persistEpisode({
        runId,
        task,
        toolCalls,
        success: runStatus === "complete",
        latencyMs,
      });

      const evalMetrics = formatEvalMetricsForTrace(
        computeLoopEvalMetrics({
          latencyMs,
          toolCalls: toolCalls.map((c) => ({
            name: c.name,
            ok: c.ok,
            status: c.status,
            latencyMs: c.latencyMs,
            body: c.body,
            args: c.args,
          })),
        }),
      );

      console.log(
        JSON.stringify({
          type: "loop_eval_metrics",
          run_id: runId,
          ...evalMetrics,
        }),
      );

      return { finalMessage, runStatus, latencyMs, evalMetrics };
    });
  } catch (err) {
    finishWorkingRun(runId, "failed");
    const latencyMs = Date.now() - runStarted;
    try {
      await persistEpisode({
        runId,
        task,
        toolCalls,
        success: false,
        latencyMs,
      });
    } catch (persistErr) {
      console.log(
        JSON.stringify({
          type: "episodic_write_error",
          run_id: runId,
          error:
            persistErr instanceof Error
              ? persistErr.message
              : String(persistErr),
        }),
      );
    }

    // Still flush so partial spans are searchable
    await flushObservability();

    try {
      await runPostAnalyzer({
        runId,
        task,
        toolCalls,
        latencyMs,
        success: false,
        mode,
        finalMessage: err instanceof Error ? err.message : String(err),
      });
    } catch (analyzeErr) {
      console.log(
        JSON.stringify({
          type: "analyzer_error",
          run_id: runId,
          error:
            analyzeErr instanceof Error
              ? analyzeErr.message
              : String(analyzeErr),
        }),
      );
    }
    console.log(
      JSON.stringify({
        type: "planner_failed",
        run_id: runId,
        mode,
        steps: toolCalls.length,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw err;
  }

  // End WORKFLOW → export spans → MCP read-back (docs: flush before short-lived exit / read)
  await flushObservability();

  const {
    analysis,
    source: analysisSource,
    reflection,
  } = await runPostAnalyzer({
    runId,
    task,
    toolCalls,
    latencyMs: core.latencyMs,
    success: core.runStatus === "complete",
    mode,
    finalMessage: core.finalMessage,
  });

  console.log(
    JSON.stringify({
      type: "planner_done",
      run_id: runId,
      mode,
      status: core.runStatus,
      steps: toolCalls.length,
      final_message: core.finalMessage,
      analyzer_flagged: analysis.flagged,
      analyzer_triggers: analysis.triggers,
      analyzer_source: analysisSource,
      reflection_status: reflection
        ? reflection.lesson.usable
          ? "promoted"
          : "candidate"
        : analysis.flagged
          ? "failed"
          : "skipped",
      lesson_evidence_count: reflection?.lesson.evidence_count,
    }),
  );

  return {
    task,
    mode,
    runId,
    steps: toolCalls.length,
    toolCalls,
    finalMessage: core.finalMessage,
    analysis,
    analysisSource,
    reflection,
    evalMetrics: core.evalMetrics,
  };
}

