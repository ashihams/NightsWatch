/**
 * One planner run — clear AO session entrypoint.
 *
 * Wrap `runOnePlanner(task)` as an AO session later; keep this function the
 * single unit of "agent work" for a natural-language task.
 *
 * Working memory (SQLite): one row per run — start → append tool calls → complete|failed.
 * Episodic memory (SQLite vectors): retrieve soft context at start; write episode on end.
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
import { withSpan } from "./observability.js";
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
import type { AnalyzeRunResult, NormalizedToolCall } from "./analyzer.js";

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
 * This is the AO-session entrypoint — wrap later as an AO session; keep the boundary here.
 */
export async function runOnePlanner(task: string): Promise<PlannerRunResult> {
  return withSpan({ kind: "AGENT", name: "runOnePlanner" }, async () => {
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

    await maybeInjectEpisodicContext(runId, task);

    let finalMessage = "";
    let runStatus: "complete" | "failed" = "complete";

    try {
      for (let step = 0; step < limit; step++) {
        const action =
          mode === "tensormux"
            ? await planNextStep(task, history)
            : offlinePlanNext(task, toolCalls);

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

      const {
        analysis,
        source: analysisSource,
        reflection,
      } = await runPostAnalyzer({
        runId,
        task,
        toolCalls,
        latencyMs,
        success: runStatus === "complete",
        mode,
        finalMessage,
      });

      console.log(
        JSON.stringify({
          type: "planner_done",
          run_id: runId,
          mode,
          status: runStatus,
          steps: toolCalls.length,
          final_message: finalMessage,
          analyzer_flagged: analysis.flagged,
          analyzer_triggers: analysis.triggers,
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
        finalMessage,
        analysis,
        analysisSource,
        reflection,
      };
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
  });
}
