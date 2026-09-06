/**
 * Neatlogs observability — deep wiring for TensorMux planner runs.
 *
 * Lifecycle (per Neatlogs TS SDK docs):
 *   await init() → WORKFLOW root (trace) → nested LLM (wrapOpenAI) + TOOL spans
 *   → await flush() BEFORE MCP read-back → shutdown on process exit.
 *
 * TensorMux is the OpenAI-compatible gateway the wrapped client talks to;
 * Neatlogs captures those chat.completions as LLM spans under the same WORKFLOW.
 */

import {
  flush,
  identify,
  init,
  log,
  setTraceOutput,
  shutdown,
  span,
  trace,
  wrapOpenAI,
} from "neatlogs";
import type OpenAI from "openai";

let tracingEnabled = false;

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

  try {
    await init({
      apiKey,
      workflowName: workflowName(),
      ...(endpoint ? { endpoint } : {}),
      // Shorter flush so CLI read-back after a run can see spans sooner
      flushInterval: Number(process.env.NEATLOGS_FLUSH_INTERVAL || 1),
      batchSize: Number(process.env.NEATLOGS_BATCH_SIZE || 32),
      captureLogs: true,
      tags: [
        "nights-watch",
        "support-agent",
        tmHost ? "tensormux" : "offline-planner",
      ].filter(Boolean),
      metadata: {
        product: "nights-watch",
        llm_gateway: tmHost ? "tensormux" : "none",
        tensormux_host: tmHost || null,
        tensormux_model: tmModel || null,
      },
      userId: "nights-watch-cli",
    });
    tracingEnabled = true;
    console.log(
      `[neatlogs] init ok — workflow=${workflowName()} endpoint=${endpoint || "https://ingest.neatlogs.com"} tensormux=${tmHost || "unset"}`,
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
    console.log(
      JSON.stringify({
        type: "neatlogs_flush",
        ok: Boolean(ok),
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
  }
}

/**
 * Wrap an OpenAI-compatible client (TensorMux /v1) for LLM spans when tracing is on.
 * wrapOpenAI nests under the active WORKFLOW root; without a root it would open its own.
 */
export function maybeWrapOpenAI(client: OpenAI): OpenAI {
  if (!tracingEnabled) return client;
  return wrapOpenAI(client) as OpenAI;
}

type SpanKind = "AGENT" | "TOOL" | "CHAIN" | "WORKFLOW" | "RETRIEVER" | "EMBEDDING";

/**
 * Run `fn` under a Neatlogs span when tracing is enabled; otherwise run plain.
 */
export async function withSpan<T>(
  options: { kind: SpanKind; name: string; toolName?: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled) return fn();
  const wrapped = span(
    {
      kind: options.kind,
      name: options.name,
      ...(options.toolName ? { toolName: options.toolName } : {}),
    },
    fn,
  );
  return wrapped();
}

export type PlannerWorkflowMeta = {
  runId: string;
  task: string;
  mode: "tensormux" | "offline";
};

/**
 * One searchable WORKFLOW root per planner run.
 * Stamps nights_watch.run_id + TensorMux gateway attrs for MCP search_traces.
 * Analyzer must run AFTER this returns and after flushObservability().
 */
export async function withPlannerWorkflow<T>(
  meta: PlannerWorkflowMeta,
  fn: () => Promise<T & { finalMessage?: string }>,
): Promise<T> {
  if (!tracingEnabled) return fn();

  const tmHost = tensormuxHost();
  const tmModel = (process.env.TENSORMUX_MODEL || "").trim();

  return identify(
    {
      endUserId: "nights-watch-agent",
      endUserMetadata: {
        run_id: meta.runId,
        mode: meta.mode,
        product: "nights-watch",
      },
    },
    () =>
      trace(
        {
          name: "runOnePlanner",
          kind: "WORKFLOW",
          endUserId: "nights-watch-agent",
          endUserMetadata: {
            run_id: meta.runId,
            mode: meta.mode,
          },
          sessionFeatureName: "support-agent-planner",
          sessionEntryPoint: "runOnePlanner",
          input: {
            run_id: meta.runId,
            task: meta.task,
            mode: meta.mode,
          },
          attributes: {
            "nights_watch.run_id": meta.runId,
            "nights_watch.mode": meta.mode,
            "nights_watch.workflow": workflowName(),
            "tensormux.enabled": meta.mode === "tensormux",
            "tensormux.host": tmHost || "none",
            "tensormux.model": tmModel || "none",
          },
        },
        async (activeSpan) => {
          try {
            activeSpan.setAttribute("nights_watch.run_id", meta.runId);
            activeSpan.setAttribute("nights_watch.mode", meta.mode);
            if (tmHost) activeSpan.setAttribute("tensormux.host", tmHost);
            if (tmModel) activeSpan.setAttribute("tensormux.model", tmModel);
          } catch {
            // attribute API may vary by SDK build — non-fatal
          }

          log("planner.start run_id={runId} mode={mode}", {
            runId: meta.runId,
            mode: meta.mode,
          });

          const result = await fn();

          setTraceOutput({
            run_id: meta.runId,
            mode: meta.mode,
            final_message:
              typeof result.finalMessage === "string"
                ? result.finalMessage.slice(0, 500)
                : undefined,
          });

          log("planner.end run_id={runId}", { runId: meta.runId });
          return result;
        },
      ),
  );
}
