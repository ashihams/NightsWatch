/**
 * Neatlogs / OpenTelemetry init — call once at process start, before planner/tool loops.
 *
 * Missing credentials: warn and continue with tracing disabled (no crash).
 */

import { flush, init, shutdown, span, wrapOpenAI } from "neatlogs";
import type OpenAI from "openai";

let tracingEnabled = false;

export function isTracingEnabled(): boolean {
  return tracingEnabled;
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

  try {
    // Workflow name describes this entrypoint (planner run), not the repo name.
    const workflowName =
      process.env.NEATLOGS_WORKFLOW_NAME || "support-agent-planner";
    await init({
      apiKey,
      workflowName,
      ...(endpoint ? { endpoint } : {}),
    });
    tracingEnabled = true;
    console.log(
      `[neatlogs] init ok — workflow=${workflowName} endpoint=${endpoint || "https://ingest.neatlogs.com"}`,
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
 * Wrap an OpenAI-compatible client for LLM spans when tracing is on.
 */
export function maybeWrapOpenAI(client: OpenAI): OpenAI {
  if (!tracingEnabled) return client;
  return wrapOpenAI(client) as OpenAI;
}

type SpanKind = "AGENT" | "TOOL" | "CHAIN" | "WORKFLOW";

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
