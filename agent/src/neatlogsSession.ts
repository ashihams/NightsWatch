/**
 * Neatlogs MCP read-back for the post-run analyzer.
 *
 * Per Neatlogs MCP docs (https://docs.neatlogs.com/integrations/mcp-tools):
 *   initialize → tools/call search_traces → get_trace_context → list_detections
 *
 * Callers MUST await flushObservability() after the WORKFLOW span ends, then
 * call tryLoadNeatlogsToolCalls — otherwise search returns no_traces_found.
 *
 * Also pulls project detections (eval rules) and any detections fired on the
 * matched trace, and optionally correlates TensorMux gateway request ring buffer.
 */

import type { NormalizedToolCall } from "./analyzer.js";
import { randomUUID } from "node:crypto";

export type NeatlogsDetectionHit = {
  name: string;
  display_name?: string;
  severity?: string;
  source: "trace" | "project_catalog" | "trend";
  fire_count_24h?: number;
  detail?: unknown;
};

export type NeatlogsLlmSpan = {
  name: string;
  model?: string;
  latency_ms?: number;
  status?: string;
  input_tokens?: number;
  output_tokens?: number;
};

export type NeatlogsTraceLoad = {
  traceId: string;
  toolCalls: NormalizedToolCall[];
  llmSpans: NeatlogsLlmSpan[];
  detections: NeatlogsDetectionHit[];
  projectDetections: NeatlogsDetectionHit[];
  latencyMs?: number;
  rawSpanCount: number;
  searchQuery: string;
  tensormuxRequests?: Array<Record<string, unknown>>;
};

function neatlogsConfigured(): boolean {
  return Boolean((process.env.NEATLOGS_API_KEY || "").trim());
}

function mcpBaseUrl(): string {
  const endpoint = (
    process.env.NEATLOGS_ENDPOINT || "https://ingest.neatlogs.com"
  ).replace(/\/+$/, "");
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

function readWaitMs(): number {
  // Short poll for OTLP index; log_trace fallback covers misses (docs agent workflow).
  const n = Number(process.env.NEATLOGS_READ_WAIT_MS || 8000);
  return Number.isFinite(n) && n >= 0 ? n : 8000;
}

function readPollMs(): number {
  const n = Number(process.env.NEATLOGS_READ_POLL_MS || 1500);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function mcpCall(
  sessionId: string | null,
  method: string,
  params?: Record<string, unknown>,
  id = 1,
): Promise<{ sessionId: string | null; body: JsonRpcResponse; ok: boolean; httpStatus: number }> {
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

  return {
    sessionId: nextSession,
    body,
    ok: res.ok && !body.error,
    httpStatus: res.status,
  };
}

function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  if (r.isError) {
    const text = r.content?.find((c) => c.type === "text")?.text;
    throw new Error(text || "mcp tool returned isError");
  }
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
  attributes?: Record<string, unknown>;
  children?: SpanNode[];
  detections?: unknown[];
};

function normalizeContextSpans(context: Record<string, unknown>): {
  spans: SpanNode[];
  latencyMs?: number;
} {
  const latencyMs =
    typeof context.latency_ms === "number"
      ? context.latency_ms
      : typeof context.total_latency_ms === "number"
        ? context.total_latency_ms
        : undefined;

  // Live MCP contract v2: flat spans[] with type/duration_ms/input_value
  if (Array.isArray(context.spans)) {
    const spans = (context.spans as Array<Record<string, unknown>>).map(
      (s) => {
        const inputRaw = s.input ?? s.input_value;
        const outputRaw = s.output ?? s.output_value;
        let input: unknown = inputRaw;
        let output: unknown = outputRaw;
        if (typeof inputRaw === "string") {
          try {
            input = JSON.parse(inputRaw);
          } catch {
            input = { value: inputRaw };
          }
        }
        if (typeof outputRaw === "string") {
          try {
            output = JSON.parse(outputRaw);
          } catch {
            output = { value: outputRaw };
          }
        }
        return {
          span_id: typeof s.span_id === "string" ? s.span_id : undefined,
          span_type: String(s.type || s.span_type || "").toUpperCase(),
          name: String(s.name || s.span_name || ""),
          status: typeof s.status === "string" ? s.status : undefined,
          latency_ms:
            typeof s.duration_ms === "number"
              ? s.duration_ms
              : typeof s.latency_ms === "number"
                ? s.latency_ms
                : undefined,
          input,
          output,
          error: typeof s.error === "string" ? s.error : undefined,
          metadata:
            s.metadata && typeof s.metadata === "object"
              ? (s.metadata as Record<string, unknown>)
              : undefined,
          children: Array.isArray(s.children)
            ? (s.children as SpanNode[])
            : undefined,
          detections: Array.isArray(s.detections) ? s.detections : undefined,
        } satisfies SpanNode;
      },
    );
    return { spans, latencyMs };
  }

  // Docs shape: nested root_span tree
  const spans: SpanNode[] = [];
  walkSpans(
    (context.root_span as SpanNode | undefined) ||
      (context.root as SpanNode | undefined),
    spans,
  );
  return { spans, latencyMs };
}

function walkSpans(node: SpanNode | undefined, out: SpanNode[]): void {
  if (!node) return;
  out.push(node);
  for (const child of node.children || []) {
    walkSpans(child, out);
  }
}

function spanAttrs(span: SpanNode): Record<string, unknown> {
  return {
    ...(span.metadata || {}),
    ...(span.attributes || {}),
  };
}

function spanToToolCall(span: SpanNode): NormalizedToolCall | null {
  const meta = spanAttrs(span);
  const type = String(span.span_type || "").toUpperCase();
  const nameRaw =
    (typeof meta.tool_name === "string" && meta.tool_name) ||
    (typeof meta["neatlogs.tool.name"] === "string" &&
      String(meta["neatlogs.tool.name"])) ||
    (span.name || "").replace(/^tool\./, "");
  if (!nameRaw) return null;
  // Live MCP uses type "TOOL"; also accept tool.* names and tool_calls from CRM webhook spans
  const looksLikeTool =
    type === "TOOL" ||
    type === "MCP_TOOL" ||
    String(span.name || "").startsWith("tool.") ||
    typeof meta.tool_name === "string";
  if (type && !looksLikeTool) {
    return null;
  }
  // Skip LLM/workflow roots that happened to match name heuristics
  if (type === "LLM" || type === "WORKFLOW" || type === "AGENT" || type === "CHAIN") {
    if (!String(span.name || "").startsWith("tool.") && !meta.tool_name) {
      return null;
    }
  }

  let input: Record<string, unknown> = {};
  if (span.input && typeof span.input === "object" && !Array.isArray(span.input)) {
    input = span.input as Record<string, unknown>;
  } else if (typeof span.input === "string" && span.input.trim()) {
    input = { value: span.input };
  }

  const statusStr = String(span.status || "").toLowerCase();
  const errored =
    statusStr === "error" ||
    statusStr === "failed" ||
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

function spanToLlm(span: SpanNode): NeatlogsLlmSpan | null {
  const type = String(span.span_type || "").toUpperCase();
  if (type !== "LLM" && !/chat\.completions|openai|llm/i.test(span.name || "")) {
    return null;
  }
  const meta = spanAttrs(span);
  return {
    name: span.name || "llm",
    model:
      (typeof meta.model === "string" && meta.model) ||
      (typeof meta["neatlogs.llm.model"] === "string"
        ? String(meta["neatlogs.llm.model"])
        : undefined),
    latency_ms: span.latency_ms,
    status: span.status,
    input_tokens:
      typeof meta.input_tokens === "number"
        ? meta.input_tokens
        : typeof meta["neatlogs.llm.token_count.prompt"] === "number"
          ? Number(meta["neatlogs.llm.token_count.prompt"])
          : undefined,
    output_tokens:
      typeof meta.output_tokens === "number"
        ? meta.output_tokens
        : typeof meta["neatlogs.llm.token_count.completion"] === "number"
          ? Number(meta["neatlogs.llm.token_count.completion"])
          : undefined,
  };
}

function normalizeDetection(
  raw: unknown,
  source: NeatlogsDetectionHit["source"],
): NeatlogsDetectionHit | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const name = String(d.name || d.detection_name || d.label || "").trim();
  if (!name) return null;
  return {
    name,
    display_name:
      typeof d.display_name === "string" ? d.display_name : undefined,
    severity: typeof d.severity === "string" ? d.severity : undefined,
    source,
    fire_count_24h:
      typeof d.fire_count_24h === "number" ? d.fire_count_24h : undefined,
    detail: d,
  };
}

function collectTraceDetections(
  context: Record<string, unknown>,
  spans: SpanNode[],
): NeatlogsDetectionHit[] {
  const out: NeatlogsDetectionHit[] = [];
  const seen = new Set<string>();

  const push = (raw: unknown) => {
    const hit = normalizeDetection(raw, "trace");
    if (!hit || seen.has(hit.name)) return;
    seen.add(hit.name);
    out.push(hit);
  };

  for (const key of ["detections", "fired_detections", "active_detections"]) {
    const v = context[key];
    if (Array.isArray(v)) v.forEach(push);
  }

  for (const span of spans) {
    if (Array.isArray(span.detections)) span.detections.forEach(push);
    const meta = spanAttrs(span);
    if (Array.isArray(meta.detections)) meta.detections.forEach(push);
  }

  return out;
}

function pickTraceId(
  traces: Array<Record<string, unknown>>,
  runId: string,
): string | undefined {
  if (traces.length === 0) return undefined;
  const needle = runId.toLowerCase();
  const byRun = traces.find((t) => {
    const blob = JSON.stringify(t).toLowerCase();
    return blob.includes(needle);
  });
  // Never accept an unrelated first hit — that falsely binds the analyzer to an
  // older support-agent-planner trace and skips log_trace fallback.
  if (!byRun) return undefined;
  return (
    (typeof byRun.trace_id === "string" && byRun.trace_id) ||
    (typeof byRun.traceId === "string" && byRun.traceId) ||
    (typeof byRun.id === "string" && byRun.id) ||
    undefined
  );
}

/** Normalize search_traces payload (docs show `traces`; live API returns `results`). */
function extractSearchTraces(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const raw = p.traces ?? p.results ?? p.items;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => t && typeof t === "object") as Array<
    Record<string, unknown>
  >;
}

async function toolCall(
  sessionId: string | null,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<{ sessionId: string | null; payload: unknown; ok: boolean; error?: string }> {
  const res = await mcpCall(
    sessionId,
    "tools/call",
    { name, arguments: args },
    id,
  );
  if (!res.ok) {
  return {
    sessionId: res.sessionId,
    payload: null,
    ok: false,
    error: res.body.error?.message || `http_${res.httpStatus}`,
  };
  }
  try {
    return {
      sessionId: res.sessionId,
      payload: unwrapToolResult(res.body.result),
      ok: true,
    };
  } catch (err) {
    return {
      sessionId: res.sessionId,
      payload: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loadTensorMuxRecent(): Promise<Array<Record<string, unknown>>> {
  const base = (process.env.TENSORMUX_BASE_URL || "").trim();
  if (!base) return [];
  try {
    const origin = new URL(base.replace(/\/v1\/?$/, "")).origin;
    const res = await fetch(`${origin}/tensormux/requests`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    if (Array.isArray(json)) {
      return json.filter((x) => x && typeof x === "object") as Array<
        Record<string, unknown>
      >;
    }
    if (json && typeof json === "object") {
      const reqs = (json as { requests?: unknown }).requests;
      if (Array.isArray(reqs)) {
        return reqs.filter((x) => x && typeof x === "object") as Array<
          Record<string, unknown>
        >;
      }
    }
  } catch {
    // TensorMux metrics are enrichment only
  }
  return [];
}

function newId(): string {
  return randomUUID();
}

/**
 * MCP log_trace — explicit analyzer snapshot when OTLP search lags (Neatlogs docs).
 */
async function pushAnalyzerTrace(params: {
  sessionId: string | null;
  nextId: () => number;
  runId: string;
  task: string;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    status: number;
    ok: boolean;
    latencyMs: number;
    body?: unknown;
    error?: string;
  }>;
  latencyMs: number;
  success: boolean;
}): Promise<{ sessionId: string | null; traceId?: string }> {
  if (params.toolCalls.length === 0) {
    return { sessionId: params.sessionId };
  }

  const started = new Date().toISOString();
  const rootId = newId();
  const spans: Array<Record<string, unknown>> = [
    {
      span_id: rootId,
      name: "runOnePlanner",
      span_type: "WORKFLOW",
      status: params.success ? "success" : "error",
      input: {
        run_id: params.runId,
        task: params.task,
        search_text: `loop.run_id ${params.runId} ${params.task}`,
      },
      output: {
        tool_call_count: params.toolCalls.length,
        loop_run_id: params.runId,
        search_text: `loop.run_id ${params.runId}`,
      },
      latency_ms: params.latencyMs,
      metadata: {
        loop_run_id: params.runId,
        nights_watch_run_id: params.runId,
        workflow: workflowName(),
        llm_gateway: "tensormux",
        source: "analyzer_log_trace",
        product: "loop",
      },
      start_time: started,
    },
  ];

  for (const c of params.toolCalls) {
    spans.push({
      span_id: newId(),
      parent_span_id: rootId,
      name: `tool.${c.name}`,
      span_type: "TOOL",
      status: c.ok ? "success" : "error",
      input: c.args,
      output: c.body ?? { status: c.status, ok: c.ok },
      error: c.error || (!c.ok ? `tool_status_${c.status}` : undefined),
      latency_ms: c.latencyMs,
      metadata: {
        tool_name: c.name,
        loop_run_id: params.runId,
        nights_watch_run_id: params.runId,
      },
      start_time: started,
    });
  }

  const res = await toolCall(
    params.sessionId,
    "log_trace",
    {
      // Live MCP schema requires workflow_name (docs examples used `name` only).
      workflow_name: workflowName(),
      name: `loop:${params.runId}`,
      spans,
      metadata: {
        framework: "loop",
        agent_name: "support-agent-planner",
        loop_run_id: params.runId,
        nights_watch_run_id: params.runId,
        tensormux: Boolean((process.env.TENSORMUX_BASE_URL || "").trim()),
      },
    },
    params.nextId(),
  );

  if (!res.ok || !res.payload || typeof res.payload !== "object") {
    console.log(
      JSON.stringify({
        type: "analyzer_neatlogs_log_trace_failed",
        error: res.error,
      }),
    );
    return { sessionId: res.sessionId };
  }

  const tid =
    typeof (res.payload as { trace_id?: string }).trace_id === "string"
      ? (res.payload as { trace_id: string }).trace_id
      : undefined;
  return { sessionId: res.sessionId, traceId: tid };
}

/**
 * Prefer Neatlogs TOOL spans for this planner run.
 * Polls search_traces until indexed or timeout (post-flush indexing lag).
 */
export async function tryLoadNeatlogsToolCalls(options: {
  runId: string;
  task: string;
  /** In-memory tool calls — used for MCP log_trace fallback when search misses */
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    status: number;
    ok: boolean;
    latencyMs: number;
    body?: unknown;
    error?: string;
  }>;
  latencyMs?: number;
  success?: boolean;
}): Promise<NeatlogsTraceLoad | null> {
  if (!neatlogsConfigured()) return null;

  let sessionId: string | null = null;
  let rpcId = 1;
  const nextId = () => ++rpcId;

  try {
    const init = await mcpCall(null, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "loop-analyzer", version: "0.3.0" },
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

    await mcpCall(sessionId, "notifications/initialized", {}, nextId());

    // Health + project binding (docs: verify before relying on data tools)
    const who = await toolCall(sessionId, "whoami", {}, nextId());
    sessionId = who.sessionId;
    if (who.ok) {
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_whoami",
          project: who.payload,
        }),
      );
    }

    // Project detection / eval catalog
    const detList = await toolCall(
      sessionId,
      "list_detections",
      { limit: 50 },
      nextId(),
    );
    sessionId = detList.sessionId;
    const projectDetections: NeatlogsDetectionHit[] = [];
    if (detList.ok && detList.payload && typeof detList.payload === "object") {
      const dets = (detList.payload as { detections?: unknown[] }).detections;
      if (Array.isArray(dets)) {
        for (const d of dets) {
          const hit = normalizeDetection(d, "project_catalog");
          if (hit) projectDetections.push(hit);
        }
      }
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_detections_catalog",
          count: projectDetections.length,
          names: projectDetections.slice(0, 20).map((d) => d.name),
        }),
      );
    }

    const queries = [
      options.runId,
      `${workflowName()} ${options.runId}`,
      `runOnePlanner ${options.runId}`,
      `loop.run_id ${options.runId}`,
      `nights_watch.run_id ${options.runId}`,
      workflowName(),
      "runOnePlanner",
    ];

    const deadline = Date.now() + readWaitMs();
    let traceId: string | undefined;
    let usedQuery = queries[0];
    let attempts = 0;

    while (Date.now() <= deadline && !traceId) {
      attempts += 1;
      for (const query of queries) {
        const search = await toolCall(
          sessionId,
          "search_traces",
          {
            query,
            limit: 10,
            filters: { date_range: "last_24h" },
          },
          nextId(),
        );
        sessionId = search.sessionId;
        if (!search.ok) continue;

        const traces = extractSearchTraces(search.payload);
        const id = pickTraceId(traces, options.runId);
        if (id) {
          traceId = id;
          usedQuery = query;
          console.log(
            JSON.stringify({
              type: "analyzer_neatlogs_search_hit",
              query,
              attempt: attempts,
              trace_id: id,
              result_count: traces.length,
            }),
          );
          break;
        }
      }
      if (!traceId && Date.now() < deadline) {
        await sleep(readPollMs());
      }
    }

    if (!traceId) {
      // Docs workflow: agent completes → log_trace → get_trace_context.
      // OTLP search can lag on free tier; push an explicit analyzer snapshot.
      const pushed = await pushAnalyzerTrace({
        sessionId,
        nextId,
        runId: options.runId,
        task: options.task,
        toolCalls: options.toolCalls || [],
        latencyMs: options.latencyMs ?? 0,
        success: options.success ?? true,
      });
      sessionId = pushed.sessionId;
      if (pushed.traceId) {
        traceId = pushed.traceId;
        usedQuery = `log_trace:${options.runId}`;
        console.log(
          JSON.stringify({
            type: "analyzer_neatlogs_log_trace",
            run_id: options.runId,
            trace_id: traceId,
            note: "search miss — pushed MCP log_trace snapshot for analyzer",
          }),
        );
      }
    }

    if (!traceId) {
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_skip",
          reason: "no_traces_found",
          query: workflowName(),
          run_id: options.runId,
          attempts,
          waited_ms: readWaitMs(),
          note: "flush+index lag or workflow mismatch — falling back to working_memory",
        }),
      );
      return null;
    }

    const ctx = await toolCall(
      sessionId,
      "get_trace_context",
      { trace_id: traceId },
      nextId(),
    );
    sessionId = ctx.sessionId;
    if (!ctx.ok || !ctx.payload || typeof ctx.payload !== "object") {
      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_skip",
          reason: "get_trace_context_failed",
          trace_id: traceId,
          error: ctx.error,
        }),
      );
      return null;
    }

    const context = ctx.payload as Record<string, unknown>;
    const { spans, latencyMs: contextLatency } = normalizeContextSpans(context);

    let toolCalls = spans
      .map(spanToToolCall)
      .filter((c): c is NormalizedToolCall => c !== null);

    const llmSpans = spans
      .map(spanToLlm)
      .filter((c): c is NeatlogsLlmSpan => c !== null);

    const detections = collectTraceDetections(context, spans);

    // Trends for detections that fired (eval signal over time)
    for (const hit of detections.slice(0, 5)) {
      const trend = await toolCall(
        sessionId,
        "get_detection_trend",
        {
          detection_name: hit.name,
          granularity: "day",
          date_range: "last_7d",
        },
        nextId(),
      );
      sessionId = trend.sessionId;
      if (trend.ok) {
        detections.push({
          ...hit,
          source: "trend",
          detail: trend.payload,
        });
      }
    }

    // Search may hit an older workflow trace without TOOL spans for THIS run.
    if (toolCalls.length === 0 && (options.toolCalls || []).length > 0) {
      const pushed = await pushAnalyzerTrace({
        sessionId,
        nextId,
        runId: options.runId,
        task: options.task,
        toolCalls: options.toolCalls || [],
        latencyMs: options.latencyMs ?? 0,
        success: options.success ?? true,
      });
      sessionId = pushed.sessionId;
      if (pushed.traceId) {
        traceId = pushed.traceId;
        usedQuery = `log_trace:${options.runId}`;
        toolCalls = (options.toolCalls || []).map((c) => ({
          name: c.name,
          args: c.args,
          status: c.status,
          ok: c.ok,
          latencyMs: c.latencyMs,
          body: c.body,
          error: c.error,
        }));
        console.log(
          JSON.stringify({
            type: "analyzer_neatlogs_log_trace",
            run_id: options.runId,
            trace_id: traceId,
            note: "search hit lacked TOOL spans — used MCP log_trace snapshot",
          }),
        );
      }
    }

    if (toolCalls.length === 0) {
      // Fresh log_trace may not be readable via get_trace_context yet —
      // use the snapshot we just pushed (still source=neatlogs for the analyzer).
      if ((options.toolCalls || []).length > 0 && usedQuery.startsWith("log_trace:")) {
        const synthetic = (options.toolCalls || []).map((c) => ({
          name: c.name,
          args: c.args,
          status: c.status,
          ok: c.ok,
          latencyMs: c.latencyMs,
          body: c.body,
          error: c.error,
        }));
        console.log(
          JSON.stringify({
            type: "analyzer_neatlogs_ok",
            run_id: options.runId,
            trace_id: traceId,
            search_query: usedQuery,
            tool_spans: synthetic.length,
            llm_spans: llmSpans.length,
            detections: detections.map((d) => d.name),
            note: "used log_trace snapshot directly (context tool spans empty)",
          }),
        );
        return {
          traceId,
          toolCalls: synthetic,
          llmSpans,
          detections,
          projectDetections,
          latencyMs: options.latencyMs,
          rawSpanCount: spans.length || synthetic.length + 1,
          searchQuery: usedQuery,
          tensormuxRequests: (await loadTensorMuxRecent()).slice(0, 10),
        };
      }

      console.log(
        JSON.stringify({
          type: "analyzer_neatlogs_skip",
          reason: "no_tool_spans",
          trace_id: traceId,
          span_count: spans.length,
          llm_spans: llmSpans.length,
          span_types: [...new Set(spans.map((s) => s.span_type || "?"))],
        }),
      );
      if (llmSpans.length > 0 || detections.length > 0) {
        console.log(
          JSON.stringify({
            type: "analyzer_neatlogs_partial",
            trace_id: traceId,
            llm_spans: llmSpans,
            detections: detections.map((d) => d.name),
          }),
        );
      }
      return null;
    }

    const tensormuxRequests = (await loadTensorMuxRecent()).slice(0, 10);

    console.log(
      JSON.stringify({
        type: "analyzer_neatlogs_ok",
        run_id: options.runId,
        trace_id: traceId,
        search_query: usedQuery,
        tool_spans: toolCalls.length,
        llm_spans: llmSpans.length,
        detections: detections.map((d) => d.name),
        project_detection_count: projectDetections.length,
        tensormux_request_samples: tensormuxRequests.length,
      }),
    );

    return {
      traceId,
      toolCalls,
      llmSpans,
      detections,
      projectDetections,
      latencyMs:
        contextLatency ??
        (typeof context.total_latency_ms === "number"
          ? context.total_latency_ms
          : options.latencyMs),
      rawSpanCount: spans.length,
      searchQuery: usedQuery,
      tensormuxRequests,
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

/**
 * Map Neatlogs detection / eval names onto analyzer trigger vocabulary.
 */
export function detectionNamesToTriggers(
  detections: NeatlogsDetectionHit[],
): string[] {
  const triggers: string[] = [];
  const seen = new Set<string>();
  for (const d of detections) {
    if (d.source === "project_catalog") continue; // catalog ≠ fired
    const n = `${d.name} ${d.display_name || ""}`.toLowerCase();
    let mapped = `neatlogs_detection:${(d.display_name || d.name).toLowerCase()}`;
    if (
      n.includes("tool_failure") ||
      n.includes("error_detected") ||
      n.includes("execution failed") ||
      n.includes("ok:false") ||
      n.includes("unscoped") ||
      n.includes("missing_customer_id")
    ) {
      mapped = "tool_failure";
    } else if (n.includes("tool_contract") || n.includes("misuse")) {
      mapped = "tool_failure";
    } else if (
      n.includes("latency") ||
      n.includes("slow llm") ||
      n.includes("expensive")
    ) {
      mapped = "high_latency";
    } else if (
      n.includes("retry") ||
      n.includes("duplicate")
    ) {
      mapped = "duplicate_tool_call";
    } else if (
      n.includes("orchestration") ||
      n.includes("novel tool sequence") ||
      n.includes("drift")
    ) {
      mapped = "novel_tool_sequence";
    }
    if (!seen.has(mapped)) {
      seen.add(mapped);
      triggers.push(mapped);
    }
  }
  return triggers;
}
