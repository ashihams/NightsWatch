/**
 * Neatlogs observability — deep wiring for TensorMux planner runs.
 *
 * Lifecycle (per Neatlogs TS SDK docs):
 *   await init() → WORKFLOW root (span with real args) → nested AGENT / LLM / TOOL
 *   → await flush() BEFORE MCP read-back → shutdown on process exit.
 *
 * Critical: pass real arguments into span()-wrapped functions so Neatlogs
 * captureInput/captureOutput populate the dashboard (empty args → empty traces).
 */

import {
  flush,
  identify,
  init,
  log,
  setTraceOutput,
  shutdown,
  span,
  wrapOpenAI,
} from "neatlogs";
import type OpenAI from "openai";

let tracingEnabled = false;
let wrappedOpenAI: OpenAI | null = null;

export function isTracingEnabled(): boolean {
  return tracingEnabled;
}

function workflowName(): string {
  return process.env.NEATLOGS_WORKFLOW_NAME || "support-agent-planner";
}

function tensormuxHost(): string {
  const base = (process.env.TENSORMUX_BASE_URL || "").trim();
  if (!base) return "";
  try {
    return new URL(base).host;
  } catch {
    return base.replace(/\/v1\/?$/, "");
  }
}

/**
 * Initialize Neatlogs once. Safe to call when NEATLOGS_API_KEY is unset.
 * @returns true when export is active
 */
export async function initObservability(): Promise<boolean> {
  const apiKey = (process.env.NEATLOGS_API_KEY || "").trim();
  if (!apiKey) {
    console.warn(
      "[neatlogs] NEATLOGS_API_KEY missing — tracing disabled; agent continues without export",
    );
    tracingEnabled = false;
    return false;
  }

  const endpoint = (process.env.NEATLOGS_ENDPOINT || "").trim();
  const tmHost = tensormuxHost();
  const tmModel = (process.env.TENSORMUX_MODEL || "").trim();

  // Prevent empty auto-root WORKFLOW shells when a child span briefly loses parent context.
  if (!process.env.NEATLOGS_AUTO_ROOT) {
    process.env.NEATLOGS_AUTO_ROOT = "false";
  }

  try {
    await init({
      apiKey,
      workflowName: workflowName(),
      ...(endpoint ? { endpoint } : {}),
      flushInterval: Number(process.env.NEATLOGS_FLUSH_INTERVAL || 1),
      batchSize: Number(process.env.NEATLOGS_BATCH_SIZE || 32),
      captureLogs: true,
      debug: process.env.NEATLOGS_DEBUG === "1",
      tags: [
        "loop",
        "support-agent",
        tmHost ? "tensormux" : "offline-planner",
      ].filter(Boolean),
      metadata: {
        product: "loop",
        llm_gateway: tmHost ? "tensormux" : "none",
        tensormux_host: tmHost || null,
        tensormux_model: tmModel || null,
      },
      userId: "loop-cli",
    });
    tracingEnabled = true;
    wrappedOpenAI = null;
    console.log(
      `[neatlogs] init ok — workflow=${workflowName()} endpoint=${endpoint || "https://ingest.neatlogs.com"} tensormux=${tmHost || "unset"} auto_root=${process.env.NEATLOGS_AUTO_ROOT}`,
    );
    return true;
  } catch (err) {
    tracingEnabled = false;
    console.warn(
      "[neatlogs] init failed — tracing disabled; agent continues:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Export buffered spans so MCP search_traces can see this run. */
export async function flushObservability(): Promise<boolean> {
  if (!tracingEnabled) return false;
  try {
    const ok = await flush();
    const settleMs = Number(process.env.NEATLOGS_FLUSH_SETTLE_MS || 2500);
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
    }
    console.log(
      JSON.stringify({
        type: "neatlogs_flush",
        ok: Boolean(ok),
        settle_ms: settleMs,
      }),
    );
    return Boolean(ok);
  } catch (err) {
    console.warn(
      "[neatlogs] flush warning:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Flush + shut down exporters. No-op when tracing was never enabled. */
export async function shutdownObservability(): Promise<void> {
  if (!tracingEnabled) return;
  try {
    await flush();
    await shutdown();
  } catch (err) {
    console.warn(
      "[neatlogs] shutdown warning:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    tracingEnabled = false;
    wrappedOpenAI = null;
  }
}

/**
 * Wrap an OpenAI-compatible client (TensorMux /v1) for LLM spans when tracing is on.
 * Reuses one wrapper so parent context stays stable across planner steps.
 */
export function maybeWrapOpenAI(client: OpenAI): OpenAI {
  if (!tracingEnabled) return client;
  if (!wrappedOpenAI) {
    wrappedOpenAI = wrapOpenAI(client) as OpenAI;
  }
  return wrappedOpenAI;
}

type SpanKind = "AGENT" | "TOOL" | "CHAIN" | "WORKFLOW" | "RETRIEVER" | "EMBEDDING";

/**
 * Run `fn(input)` under a Neatlogs span. Always pass `input` so captureInput works.
 */
export async function withSpan<TInput, TResult>(
  options: { kind: SpanKind; name: string; toolName?: string },
  fn: (input: TInput) => Promise<TResult>,
  input: TInput,
): Promise<TResult> {
  if (!tracingEnabled) return fn(input);
  const wrapped = span(
    {
      kind: options.kind,
      name: options.name,
      captureInput: true,
      captureOutput: true,
      ...(options.toolName ? { toolName: options.toolName } : {}),
    },
    fn,
  );
  return wrapped(input);
}

export type PlannerWorkflowMeta = {
  runId: string;
  task: string;
  mode: "tensormux" | "offline";
};

type PlannerWorkflowResult = {
  finalMessage?: string;
  evalMetrics?: Record<string, unknown>;
};

/**
 * One searchable WORKFLOW root per planner run.
 * Uses span() (not nested trace) so the task is captured as WORKFLOW input.
 * Analyzer must run AFTER this returns and after flushObservability().
 */
export async function withPlannerWorkflow<T extends PlannerWorkflowResult>(
  meta: PlannerWorkflowMeta,
  fn: (meta: PlannerWorkflowMeta) => Promise<T>,
): Promise<T> {
  if (!tracingEnabled) return fn(meta);

  const runWorkflow = span(
    {
      kind: "WORKFLOW",
      name: workflowName(),
      captureInput: true,
      captureOutput: true,
      goal: "Plan and execute CRM support tools for the user task",
      role: "support-ops-planner",
    },
    async (m: PlannerWorkflowMeta) => {
      log("planner.start run_id={runId} mode={mode} task={task}", {
        runId: m.runId,
        mode: m.mode,
        task: m.task.slice(0, 200),
      });

      const result = await fn(m);

      const output = {
        run_id: m.runId,
        loop_run_id: m.runId,
        mode: m.mode,
        product: "loop",
        search_text: `loop.run_id ${m.runId} ${m.task}`,
        final_message:
          typeof result.finalMessage === "string"
            ? result.finalMessage.slice(0, 500)
            : undefined,
        ...(result.evalMetrics || {}),
      };
      setTraceOutput(output);

      if (result.evalMetrics) {
        log("loop.eval {metrics}", {
          metrics: JSON.stringify(result.evalMetrics).slice(0, 800),
        });
      }

      log("planner.end run_id={runId}", { runId: m.runId });
      return result;
    },
  );

  return identify(
    {
      endUserId: "loop-agent",
      endUserMetadata: {
        run_id: meta.runId,
        mode: meta.mode,
        product: "loop",
      },
      sessionFeatureName: workflowName(),
      sessionEntryPoint: "runOnePlanner",
    },
    () => runWorkflow(meta),
  );
}
