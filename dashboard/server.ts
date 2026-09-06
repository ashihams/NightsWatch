/**
 * Demo dashboard (Step 10).
 *
 *   GET  /api/trajectory
 *   GET  /api/lessons
 *   GET  /api/stack
 *   GET  /api/health
 *   GET  /api/demo/status
 *   GET  /api/demo/events   — SSE live log stream
 *   POST /api/demo/run      — start npm run replay:demo (one at a time)
 */

import { config } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSemanticMemory,
  listLessons,
  semanticFallbackPath,
} from "../agent/src/semanticMemory.js";
import { listEpisodes, episodicMemoryDbPath } from "../agent/src/episodicMemory.js";
import {
  embeddingApiConfigured,
  ollamaEmbedEnabled,
} from "../agent/src/embeddings.js";
import { tensormuxConfigured } from "../agent/src/llm.js";
import { runReplayDemo } from "../scripts/replay-demo.js";

const nodeRequire = createRequire(resolve(process.cwd(), "package.json"));
const { startMockCrmServer } = nodeRequire("./tools/mock-server/index.js") as {
  startMockCrmServer: (opts?: {
    port?: number;
    host?: string;
  }) => Promise<{
    port: number;
    baseUrl: string;
    close: () => Promise<void>;
  }>;
};
config({ path: resolve(process.cwd(), ".env"), override: true });

const PUBLIC_DIR = resolve(process.cwd(), "dashboard/public");
const PORT = Number(process.env.DASHBOARD_PORT || 3847);
const HINT =
  "No replay data yet. Click RUN DEMO (offline planner + in-process mock CRM).";

function isVercel(): boolean {
  return Boolean(process.env.VERCEL);
}

/** Match replay-demo SQLite isolation so the dashboard sees the demo spine. */
function pointAtReplayDemoStores(): void {
  const root =
    process.env.REPLAY_DATA_ROOT ||
    (isVercel() ? "/tmp/loop-replay-demo" : "./data/replay-demo");
  process.env.WORKING_DB_PATH =
    process.env.REPLAY_WORKING_DB_PATH || `${root}/working.sqlite`;
  process.env.EPISODIC_DB_PATH =
    process.env.REPLAY_EPISODIC_DB_PATH || `${root}/episodic.sqlite`;
  process.env.SEMANTIC_FALLBACK_PATH =
    process.env.REPLAY_SEMANTIC_FALLBACK_PATH ||
    `${root}/semantic_lessons.json`;
  process.env.PENDING_REFLECTION_DIR =
    process.env.REPLAY_PENDING_REFLECTION_DIR ||
    `${root}/pending_reflection`;
  if (!process.env.REPLAY_TRAJECTORY_PATH) {
    process.env.REPLAY_TRAJECTORY_PATH = `${root}/trajectory.json`;
  }
}

function trajectoryPath(): string {
  const candidates = [
    process.env.REPLAY_TRAJECTORY_PATH,
    isVercel() ? "/tmp/loop-replay-demo/trajectory.json" : null,
    "./data/replay-demo/trajectory.json",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const abs = c.startsWith("/") ? c : resolve(process.cwd(), c);
    if (existsSync(abs)) return abs;
  }
  return resolve(process.cwd(), "dashboard/fixtures/trajectory.json");
}

function toolsBaseUrl(): string {
  return (process.env.TOOLS_BASE_URL || "http://localhost:5678").replace(
    /\/+$/,
    "",
  );
}

function neo4jConfigured(): boolean {
  return Boolean(
    (process.env.NEO4J_URI || "").trim() &&
      (process.env.NEO4J_USER || "").trim() &&
      (process.env.NEO4J_PASSWORD || "").trim(),
  );
}

type TrajectoryRow = {
  run_id: string;
  label: string;
  success: boolean;
  tool_call_count: number;
  failed_tool_calls: number;
  latency_ms: number;
  [key: string]: unknown;
};

type DemoEvent = {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
  parsed?: Record<string, unknown> | null;
};

type DemoState = {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  phase: string | null;
  pid: number | null;
  events: DemoEvent[];
};

const demoState: DemoState = {
  running: false,
  started_at: null,
  finished_at: null,
  exit_code: null,
  phase: null,
  pid: null,
  events: [],
};

const sseClients = new Set<ServerResponse>();
let demoChild: ChildProcessWithoutNullStreams | null = null;
const MAX_EVENTS = 400;

function pushDemoEvent(
  stream: DemoEvent["stream"],
  line: string,
  parsed?: Record<string, unknown> | null,
): void {
  const evt: DemoEvent = {
    ts: new Date().toISOString(),
    stream,
    line,
    parsed: parsed ?? null,
  };
  demoState.events.push(evt);
  if (demoState.events.length > MAX_EVENTS) {
    demoState.events.splice(0, demoState.events.length - MAX_EVENTS);
  }
  if (parsed?.type === "replay_scenario" && typeof parsed.label === "string") {
    demoState.phase = parsed.label;
  } else if (parsed?.type === "replay_demo_ok") {
    demoState.phase = "done";
  } else if (parsed?.type === "replay_demo_start") {
    demoState.phase = "boot";
  }
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function attachLineBuffer(
  chunkStream: NodeJS.ReadableStream,
  stream: "stdout" | "stderr",
): void {
  let buf = "";
  chunkStream.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line.trim()) continue;
      pushDemoEvent(stream, line, tryParseJsonLine(line));
    }
  });
  chunkStream.on("end", () => {
    if (buf.trim()) {
      pushDemoEvent(stream, buf, tryParseJsonLine(buf));
      buf = "";
    }
  });
}

/**
 * In-process offline demo: ephemeral mock CRM + hash embeds + offline planner.
 * Streams SSE on `res` (used on Vercel where spawn + cross-request SSE cannot work).
 */
async function runInlineOfflineDemo(res: ServerResponse): Promise<void> {
  if (demoState.running) {
    sendJson(res, 409, {
      ok: false,
      error: "demo already running",
      ...demoStatusPayload(),
    });
    return;
  }

  demoState.running = true;
  demoState.started_at = new Date().toISOString();
  demoState.finished_at = null;
  demoState.exit_code = null;
  demoState.phase = "starting";
  demoState.events = [];
  demoState.pid = null;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  });
  res.write(
    `event: hello\ndata: ${JSON.stringify({ ...demoStatusPayload(), mode: "inline_offline" })}\n\n`,
  );

  const writeEvt = (
    stream: DemoEvent["stream"],
    line: string,
    parsed?: Record<string, unknown> | null,
  ) => {
    pushDemoEvent(stream, line, parsed ?? tryParseJsonLine(line));
    // pushDemoEvent already fans out to sseClients; also write to this response
    const evt = demoState.events[demoState.events.length - 1];
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      // client gone
    }
  };

  let mock: Awaited<ReturnType<typeof startMockCrmServer>> | null = null;
  try {
    process.env.MOCK_CRM_DETERMINISTIC = "1";
    process.env.TOOLS_KIND = "mock";
    process.env.REPLAY_USE_OFFLINE = "1";
    if (isVercel()) {
      process.env.REPLAY_DATA_ROOT = "/tmp/loop-replay-demo";
    }
    pointAtReplayDemoStores();

    mock = await startMockCrmServer({ host: "127.0.0.1", port: 0 });
    process.env.TOOLS_BASE_URL = mock.baseUrl;
    writeEvt(
      "system",
      `inline mock CRM ${mock.baseUrl} · offline planner · hash embeds`,
    );

    const result = await runReplayDemo({
      forceOffline: true,
      onLog: (line, stream) => {
        writeEvt(stream, line);
      },
    });

    demoState.exit_code = result.exit_code;
    demoState.phase = result.ok ? "done" : "failed";
    demoState.finished_at = new Date().toISOString();
    demoState.running = false;

    res.write(
      `event: done\ndata: ${JSON.stringify({
        exit_code: result.exit_code,
        phase: demoState.phase,
        ok: result.ok,
        trajectory: {
          type: "replay_trajectory",
          updated_at: new Date().toISOString(),
          rows: result.rows,
          scorecard: result.scorecard ?? null,
        },
      })}\n\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeEvt("system", `inline demo error: ${msg}`);
    demoState.running = false;
    demoState.finished_at = new Date().toISOString();
    demoState.exit_code = 1;
    demoState.phase = "error";
    try {
      res.write(
        `event: done\ndata: ${JSON.stringify({
          exit_code: 1,
          phase: "error",
          ok: false,
          error: msg,
        })}\n\n`,
      );
    } catch {
      // ignore
    }
  } finally {
    if (mock) {
      await mock.close().catch(() => undefined);
    }
    try {
      res.end();
    } catch {
      // ignore
    }
  }
}

function startDemoRun(): { ok: boolean; error?: string } {
  if (demoState.running) {
    return { ok: false, error: "demo already running" };
  }

  demoState.running = true;
  demoState.started_at = new Date().toISOString();
  demoState.finished_at = null;
  demoState.exit_code = null;
  demoState.phase = "starting";
  demoState.events = [];

  const env = {
    ...process.env,
    FORCE_COLOR: "0",
    NPM_CONFIG_COLOR: "false",
    // Prefer .env (dotenv override above); never inherit a stale shell REPLAY_USE_OFFLINE=1.
    REPLAY_USE_OFFLINE: process.env.REPLAY_USE_OFFLINE || "0",
  };

  const tsxCli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const script = resolve(process.cwd(), "scripts/replay-demo.ts");

  let child: ChildProcessWithoutNullStreams;
  try {
    // Prefer direct node+tsx (avoids Windows npx.cmd EINVAL).
    child = spawn(process.execPath, [tsxCli, script], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
    });
  } catch (err) {
    demoState.running = false;
    demoState.finished_at = new Date().toISOString();
    demoState.exit_code = 1;
    demoState.phase = "error";
    const msg = err instanceof Error ? err.message : String(err);
    pushDemoEvent("system", `spawn error: ${msg}`);
    return { ok: false, error: msg };
  }

  demoChild = child;
  demoState.pid = child.pid ?? null;
  pushDemoEvent("system", `spawn replay:demo pid=${demoState.pid}`);

  attachLineBuffer(child.stdout, "stdout");
  attachLineBuffer(child.stderr, "stderr");

  child.on("error", (err) => {
    pushDemoEvent("system", `spawn error: ${err.message}`);
    demoState.running = false;
    demoState.finished_at = new Date().toISOString();
    demoState.exit_code = 1;
    demoState.phase = "error";
    demoChild = null;
  });

  child.on("close", (code) => {
    demoState.running = false;
    demoState.finished_at = new Date().toISOString();
    demoState.exit_code = code ?? 1;
    if (demoState.phase !== "done" && demoState.phase !== "error") {
      demoState.phase = code === 0 ? "done" : "failed";
    }
    pushDemoEvent("system", `exit_code=${code ?? "null"}`);
    demoChild = null;
    for (const client of sseClients) {
      try {
        client.write(
          `event: done\ndata: ${JSON.stringify({
            exit_code: demoState.exit_code,
            phase: demoState.phase,
          })}\n\n`,
        );
      } catch {
        sseClients.delete(client);
      }
    }
  });

  return { ok: true };
}

function demoStatusPayload(): Record<string, unknown> {
  return {
    type: "demo_status",
    running: demoState.running,
    started_at: demoState.started_at,
    finished_at: demoState.finished_at,
    exit_code: demoState.exit_code,
    phase: demoState.phase,
    pid: demoState.pid,
    event_count: demoState.events.length,
  };
}

function readTrajectory(): {
  empty: boolean;
  hint: string | null;
  updated_at: string | null;
  rows: TrajectoryRow[];
  path: string;
  scorecard: unknown | null;
} {
  const path = trajectoryPath();
  if (!existsSync(path)) {
    return {
      empty: true,
      hint: HINT,
      updated_at: null,
      rows: [],
      path,
      scorecard: null,
    };
  }
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text) as {
      updated_at?: string;
      rows?: TrajectoryRow[];
      scorecard?: unknown;
    };
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    if (rows.length === 0) {
      return {
        empty: true,
        hint: HINT,
        updated_at: raw.updated_at ?? null,
        rows,
        path,
        scorecard: raw.scorecard ?? null,
      };
    }
    return {
      empty: false,
      hint: null,
      updated_at: raw.updated_at ?? null,
      rows,
      path,
      scorecard: raw.scorecard ?? null,
    };
  } catch {
    return {
      empty: true,
      hint: HINT,
      updated_at: null,
      rows: [],
      path,
      scorecard: null,
    };
  }
}

async function readLessonsPayload(): Promise<{
  empty: boolean;
  hint: string | null;
  fallback_path: string;
  neo4j_configured: boolean;
  backend: "neo4j" | "local_fallback" | "mixed" | "none";
  usable: unknown[];
  pending: unknown[];
}> {
  const lessons = await listLessons();
  const mapped = lessons.map((l) => ({
    id: l.id,
    text: l.text,
    tool: l.tool,
    factors: l.factors,
    evidence_count: l.evidence_count,
    confidence: l.confidence,
    usable: l.usable,
    supporting_run_ids: l.supporting_run_ids,
    condition: l.condition,
    backend: l.backend,
    created_at: l.created_at,
  }));
  const usable = mapped.filter((l) => l.usable && l.evidence_count >= 2);
  const pending = mapped.filter((l) => !l.usable || l.evidence_count < 2);
  const backends = new Set(mapped.map((l) => l.backend));
  let backend: "neo4j" | "local_fallback" | "mixed" | "none" = "none";
  if (backends.size === 1) {
    backend = [...backends][0] as "neo4j" | "local_fallback";
  } else if (backends.size > 1) {
    backend = "mixed";
  } else if (neo4jConfigured()) {
    backend = "neo4j";
  } else {
    backend = "local_fallback";
  }
  const empty = mapped.length === 0;
  return {
    empty,
    hint: empty ? HINT : null,
    fallback_path: semanticFallbackPath(),
    neo4j_configured: neo4jConfigured(),
    backend,
    usable,
    pending,
  };
}

async function probeTools(): Promise<{
  ok: boolean;
  base_url: string;
  kind: "n8n" | "mock" | "unknown" | "down" | "inline";
  status: number | null;
  note: string;
}> {
  if (isVercel()) {
    return {
      ok: true,
      base_url: "(in-process on RUN DEMO)",
      kind: "inline",
      status: 200,
      note: "Vercel RUN DEMO spins up deterministic mock CRM in-process (offline planner + hash embeds). No localhost n8n/Ollama required.",
    };
  }
  const base = toolsBaseUrl();
  try {
    const res = await fetch(`${base}/webhook/search_customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "dashboard-ping" }),
      signal: AbortSignal.timeout(4000),
    });
    let kind: "n8n" | "mock" | "unknown" = "unknown";
    if (process.env.TOOLS_KIND === "mock") kind = "mock";
    else if (process.env.TOOLS_KIND === "n8n") kind = "n8n";
    else kind = "n8n";
    return {
      ok: res.status >= 200 && res.status < 500,
      base_url: base,
      kind: res.ok || res.status === 400 ? kind : "unknown",
      status: res.status,
      note:
        "CRM payloads are synthetic fixture customers/orders (cust_1001…), not a live Salesforce/HubSpot tenant. Engine may be real n8n or the Node mock.",
    };
  } catch (err) {
    return {
      ok: false,
      base_url: base,
      kind: "down",
      status: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readStackPayload(): Promise<Record<string, unknown>> {
  const tools = await probeTools();
  let neo4jOk: boolean | null = null;
  let lessonBackend: string | null = null;
  if (neo4jConfigured()) {
    try {
      const lessons = await listLessons();
      neo4jOk = true;
      lessonBackend = lessons[0]?.backend || "neo4j";
    } catch (err) {
      neo4jOk = false;
      lessonBackend = err instanceof Error ? err.message : String(err);
    }
  }

  let episodicCount = 0;
  try {
    episodicCount = listEpisodes(50).length;
  } catch {
    episodicCount = 0;
  }

  const neatlogsKey = Boolean((process.env.NEATLOGS_API_KEY || "").trim());
  const vercelOffline = isVercel();

  return {
    type: "stack",
    updated_at: new Date().toISOString(),
    demo: demoStatusPayload(),
    mode: vercelOffline ? "vercel_offline_inline" : "local",
    tools_crm: {
      ...tools,
      data: "fixture",
    },
    neo4j: {
      configured: neo4jConfigured(),
      ok: neo4jOk,
      uri: (process.env.NEO4J_URI || "").trim() || null,
      user: (process.env.NEO4J_USER || "").trim() || null,
      lesson_backend: lessonBackend,
      fallback_path: semanticFallbackPath(),
    },
    embeddings: {
      api_configured: vercelOffline ? false : embeddingApiConfigured(),
      ollama_enabled: vercelOffline ? false : ollamaEmbedEnabled(),
      model: vercelOffline
        ? "hash-bow-256"
        : (process.env.EMBEDDING_MODEL || "").trim() ||
          (embeddingApiConfigured() || ollamaEmbedEnabled()
            ? "nomic-embed-text"
            : "hash-bow-256"),
      base_url: vercelOffline
        ? null
        : (process.env.EMBEDDING_BASE_URL || "").trim() || null,
    },
    episodic: {
      path: episodicMemoryDbPath(),
      recent_count: episodicCount,
    },
    tensormux: {
      configured: vercelOffline ? false : tensormuxConfigured(),
      base_url: vercelOffline
        ? null
        : (process.env.TENSORMUX_BASE_URL || "").trim() || null,
      model: vercelOffline
        ? "offline-planner"
        : (process.env.TENSORMUX_MODEL || "").trim() || null,
    },
    open_telemetry: {
      provider: "neatlogs",
      configured: neatlogsKey,
      endpoint:
        (process.env.NEATLOGS_ENDPOINT || "").trim() ||
        "https://ingest.neatlogs.com",
      workflow:
        (process.env.NEATLOGS_WORKFLOW_NAME || "").trim() ||
        "support-agent-planner",
      note: "Agent exports OTel-compatible spans via Neatlogs SDK (not a self-hosted Jaeger/collector).",
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function attachSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.write(`event: hello\ndata: ${JSON.stringify(demoStatusPayload())}\n\n`);
  for (const evt of demoState.events.slice(-80)) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  sseClients.add(res);
  res.on("close", () => {
    sseClients.delete(res);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(reqPath: string, res: ServerResponse): void {
  const rel = reqPath === "/" ? "/index.html" : reqPath;
  const safe = rel.replace(/\.\./g, "");
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = MIME[extname(file)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(readFileSync(file));
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!process.env.__LOOP_DASHBOARD_STORES) {
    pointAtReplayDemoStores();
    process.env.__LOOP_DASHBOARD_STORES = "1";
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/api/trajectory") {
    sendJson(res, 200, { type: "trajectory", ...readTrajectory() });
    return;
  }

  if (req.method === "GET" && path === "/api/lessons") {
    sendJson(res, 200, {
      type: "lessons",
      ...(await readLessonsPayload()),
    });
    return;
  }

  if (req.method === "GET" && path === "/api/stack") {
    sendJson(res, 200, await readStackPayload());
    return;
  }

  if (req.method === "GET" && path === "/api/demo/status") {
    sendJson(res, 200, demoStatusPayload());
    return;
  }

  if (req.method === "GET" && path === "/api/demo/events") {
    attachSse(res);
    return;
  }

  if (req.method === "POST" && path === "/api/demo/run") {
    await readBody(req);
    // Vercel: one-request inline offline demo (spawn + cross-request SSE cannot work).
    if (isVercel() || process.env.LOOP_INLINE_DEMO === "1") {
      await runInlineOfflineDemo(res);
      return;
    }
    const started = startDemoRun();
    if (!started.ok) {
      sendJson(res, 409, {
        ok: false,
        error: started.error,
        ...demoStatusPayload(),
      });
      return;
    }
    sendJson(res, 202, { ok: true, ...demoStatusPayload() });
    return;
  }

  if (req.method === "GET" && path === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      trajectory_path: trajectoryPath(),
      semantic_fallback: semanticFallbackPath(),
      neo4j_configured: neo4jConfigured(),
      tools_base_url: toolsBaseUrl(),
      demo: demoStatusPayload(),
    });
    return;
  }

  if (req.method === "GET") {
    serveStatic(path, res);
    return;
  }

  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
}

async function main(): Promise<void> {
  pointAtReplayDemoStores();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  server.listen(PORT, () => {
    console.log(
      JSON.stringify({
        type: "dashboard_listen",
        url: `http://localhost:${PORT}`,
        trajectory: trajectoryPath(),
        lessons_fallback: semanticFallbackPath(),
        neo4j: neo4jConfigured(),
        tools: toolsBaseUrl(),
        note: "POST /api/demo/run starts live replay:demo; GET /api/demo/events for SSE",
      }),
    );
  });

  const shutdown = async () => {
    if (demoChild) {
      try {
        demoChild.kill();
      } catch {
        // ignore
      }
    }
    await closeSemanticMemory().catch(() => undefined);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Local long-running server only; Vercel uses api/index.ts → handle().
if (!process.env.VERCEL && process.argv[1]?.includes("dashboard/server")) {
  main().catch(async (err) => {
    console.error(err);
    await closeSemanticMemory().catch(() => undefined);
    process.exit(1);
  });
}
