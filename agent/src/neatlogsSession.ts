/**
 * Prefer Neatlogs session/trace API when NEATLOGS_* is set.
 *
 * Uses the Neatlogs MCP HTTP endpoint (same host as ingest) to search for the
 * latest workflow trace and pull TOOL spans. On any failure, callers fall back
 * to working-memory tool_call_log (same analyzer triggers).
 */

import type { NormalizedToolCall } from "./analyzer.js";

export type NeatlogsTraceLoad = {
  traceId: string;
  toolCalls: NormalizedToolCall[];
  latencyMs?: number;
  rawSpanCount: number;
};

function neatlogsConfigured(): boolean {
  return Boolean((process.env.NEATLOGS_API_KEY || "").trim());
}

function mcpBaseUrl(): string {
  const endpoint = (
    process.env.NEATLOGS_ENDPOINT || "https://ingest.neatlogs.com"
  ).replace(/\/+$/, "");
  // Allow NEATLOGS_MCP_URL override; else derive from ingest host.
  const override = (process.env.NEATLOGS_MCP_URL || "").trim();
  if (override) return override.replace(/\/+$/, "");
  return `${endpoint}/mcp`;
}

function apiKey(): string {
  return (process.env.NEATLOGS_API_KEY || "").trim();
}

function workflowName(): string {
  return process.env.NEATLOGS_WORKFLOW_NAME || "support-agent-planner";
}

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

async function mcpCall(
  sessionId: string | null,
  method: string,
  params?: Record<string, unknown>,
  id = 1,
): Promise<{ sessionId: string | null; body: JsonRpcResponse; ok: boolean }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(mcpBaseUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    }),
  });

  const nextSession =
    res.headers.get("mcp-session-id") ||
    res.headers.get("Mcp-Session-Id") ||
    sessionId;

  const text = await res.text();
  let body: JsonRpcResponse = {};
  try {
    // Streamable HTTP may return SSE; take the last JSON payload if so.
    if (text.trim().startsWith("event:") || text.includes("data:")) {
      const dataLines = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      const last = dataLines[dataLines.length - 1];
      body = last ? (JSON.parse(last) as JsonRpcResponse) : {};
    } else {
      body = text ? (JSON.parse(text) as JsonRpcResponse) : {};
    }
  } catch {
    body = { error: { message: `non-json mcp response: ${text.slice(0, 200)}` } };
  }

  return { sessionId: nextSession, body, ok: res.ok && !body.error };
}

function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (Array.isArray(r.content)) {
    const textPart = r.content.find((c) => c.type === "text" && c.text);
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return textPart.text;
      }
    }
  }
  return result;
}

type SpanNode = {
  span_id?: string;
  span_type?: string;
  name?: string;
  status?: string;
  latency_ms?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  children?: SpanNode[];
};

function walkSpans(node: SpanNode | undefined, out: SpanNode[]): void {
  if (!node) return;
  out.push(node);
  for (const child of node.children || []) {
    walkSpans(child, out);
  }
}

function spanToToolCall(span: SpanNode): NormalizedToolCall | null {
  const meta = span.metadata || {};
  const type = String(span.span_type || "").toUpperCase();
  const nameRaw =
    (typeof meta.tool_name === "string" && meta.tool_name) ||
    (span.name || "").replace(/^tool\./, "");
  if (!nameRaw) return null;
  if (type && type !== "TOOL" && !String(span.name || "").startsWith("tool.")) {
    return null;
  }

  const input =
    span.input && typeof span.input === "object" && !Array.isArray(span.input)
      ? (span.input as Record<string, unknown>)
      : {};

  const statusStr = String(span.status || "").toLowerCase();
  const errored =
    statusStr === "error" ||
    Boolean(span.error) ||
    (span.output &&
      typeof span.output === "object" &&
      (span.output as { ok?: boolean }).ok === false);

  let status = 200;
  if (
    span.output &&
    typeof span.output === "object" &&
    typeof (span.output as { status?: number }).status === "number"
  ) {
    status = Number((span.output as { status: number }).status);
  } else if (errored) {
    status = 500;
  }

  return {
    name: nameRaw,
    args: input,
    status,
    ok: !errored && status >= 200 && status < 300,
    latencyMs: Number(span.latency_ms ?? 0),
    body: span.output,
    error: span.error,
  };
}

/**
 * Try to load TOOL spans for this planner run from Neatlogs.
 * Returns null when NEATLOGS_* unset or the API is unavailable.
 */
export async function tryLoadNeatlogsToolCalls(options: {
  runId: string;
  task: string;
}): Promise<NeatlogsTraceLoad | null> {
  if (!neatlogsConfigured()) return null;

  let sessionId: string | null = null;
  try {
    const init = await mcpCall(null, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nights-watch-analyzer", version: "0.1.0" },
    });
    sessionId = init.sessionId;
    if (!init.ok) {
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_skip",
          reason: "mcp_initialize_failed",
          error: init.body.error?.message || "unknown",
        }),
      );
      return null;
    }

    // Notify initialized (best-effort; some servers require it)
    await mcpCall(sessionId, "notifications/initialized", {}, 2);

    const search = await mcpCall(
      sessionId,
      "tools/call",
      {
        name: "search_traces",
        arguments: {
          query: `${workflowName()} ${options.runId}`.trim(),
          limit: 5,
          filters: { date_range: "last_24h" },
        },
      },
      3,
    );

    if (!search.ok) {
      // Retry with workflow name only
      const search2 = await mcpCall(
        sessionId,
        "tools/call",
        {
          name: "search_traces",
          arguments: {
            query: workflowName(),
            limit: 5,
            filters: { date_range: "last_24h" },
          },
        },
        4,
      );
      if (!search2.ok) {
        console.log(
          JSON.stringify({
            type: "analyzer_neatlogs_skip",
            reason: "search_traces_failed",
            error: search2.body.error?.message || search.body.error?.message,
          }),
        );
        return null;
      }
      Object.assign(search, search2);
    }

    const searchPayload = unwrapToolResult(search.body.result) as {
      traces?: Array<{ trace_id?: string; name?: string }>;
    };
    const traces = Array.isArray(searchPayload?.traces)
      ? searchPayload.traces
      : [];
    const traceId = traces[0]?.trace_id;
    if (!traceId) {
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_skip",
          reason: "no_traces_found",
          query: workflowName(),
        }),
      );
      return null;
    }

    const ctx = await mcpCall(
      sessionId,
      "tools/call",
      {
        name: "get_trace_context",
        arguments: { trace_id: traceId },
      },
      5,
    );
    if (!ctx.ok) {
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_skip",
          reason: "get_trace_context_failed",
          trace_id: traceId,
          error: ctx.body.error?.message,
        }),
      );
      return null;
    }

    const context = unwrapToolResult(ctx.body.result) as {
      trace_id?: string;
      total_latency_ms?: number;
      root_span?: SpanNode;
      span_count?: number;
    };

    const spans: SpanNode[] = [];
    walkSpans(context.root_span, spans);
    const toolCalls = spans
      .map(spanToToolCall)
      .filter((c): c is NormalizedToolCall => c !== null);

    if (toolCalls.length === 0) {
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_skip",
          reason: "no_tool_spans",
          trace_id: traceId,
          span_count: spans.length,
        }),
      );
      return null;
    }

    console.log(
      JSON.stringify({
        type: "analyzer_neatlogs_ok",
        run_id: options.runId,
        trace_id: traceId,
        tool_spans: toolCalls.length,
      }),
    );

    return {
      traceId,
      toolCalls,
      latencyMs: context.total_latency_ms,
      rawSpanCount: spans.length,
    };
  } catch (err) {
    console.log(
      JSON.stringify({
        type: "analyzer_neatlogs_skip",
        reason: "exception",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  } finally {
    if (sessionId) {
      try {
        await fetch(mcpBaseUrl(), {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${apiKey()}`,
            "mcp-session-id": sessionId,
          },
        });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export function isNeatlogsReadConfigured(): boolean {
  return neatlogsConfigured();
}
