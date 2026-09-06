/**
 * One planner run — clear AO session entrypoint.
 *
 * Wrap `runOnePlanner(task)` as an AO session later; keep this function the
 * single unit of "agent work" for a natural-language task.
 *
 * Working memory (SQLite): one row per run — start → append tool calls → complete|failed.
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
  startWorkingRun,
} from "./workingMemory.js";

export type PlannerRunResult = {
  task: string;
  mode: "tensormux" | "offline";
  runId: string;
  steps: number;
  toolCalls: ToolCallResult[];
  finalMessage: string;
};

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function maxSteps(): number {
  const n = Number(process.env.AGENT_MAX_STEPS || 8);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
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

      console.log(
        JSON.stringify({
          type: "planner_done",
          run_id: runId,
          mode,
          status: runStatus,
          steps: toolCalls.length,
          final_message: finalMessage,
        }),
      );

      return {
        task,
        mode,
        runId,
        steps: toolCalls.length,
        toolCalls,
        finalMessage,
      };
    } catch (err) {
      finishWorkingRun(runId, "failed");
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
