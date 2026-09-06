/**
 * Minimal demo dashboard (Step 10).
 *
 * Read-only HTTP API + static page:
 *   GET /api/trajectory  — latest replay spine rows
 *   GET /api/lessons     — usable + pending semantic lessons
 *
 * Points store env at ./data/replay-demo/ (same isolation as npm run replay:demo).
 * Does not reimplement planner / reflection / strategy logic.
 */

import { config } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  closeSemanticMemory,
  listLessons,
  semanticFallbackPath,
} from "../agent/src/semanticMemory.js";

config({ path: resolve(process.cwd(), ".env") });

const PUBLIC_DIR = resolve(process.cwd(), "dashboard/public");
const PORT = Number(process.env.DASHBOARD_PORT || 3847);
const HINT = "No replay data yet. In another terminal run: npm run replay:demo (with npm run tools on :5678).";

/** Match replay-demo store isolation so the dashboard sees the demo spine. */
function pointAtReplayDemoStores(): void {
  process.env.WORKING_DB_PATH =
    process.env.REPLAY_WORKING_DB_PATH || "./data/replay-demo/working.sqlite";
  process.env.EPISODIC_DB_PATH =
    process.env.REPLAY_EPISODIC_DB_PATH || "./data/replay-demo/episodic.sqlite";
  process.env.SEMANTIC_FALLBACK_PATH =
    process.env.REPLAY_SEMANTIC_FALLBACK_PATH ||
    "./data/replay-demo/semantic_lessons.json";
  process.env.PENDING_REFLECTION_DIR =
    process.env.REPLAY_PENDING_REFLECTION_DIR ||
    "./data/replay-demo/pending_reflection";
}

function trajectoryPath(): string {
  return resolve(
    process.cwd(),
    process.env.REPLAY_TRAJECTORY_PATH || "./data/replay-demo/trajectory.json",
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

function readTrajectory(): {
  empty: boolean;
  hint: string | null;
  updated_at: string | null;
  rows: TrajectoryRow[];
  path: string;
} {
  const path = trajectoryPath();
  if (!existsSync(path)) {
    return { empty: true, hint: HINT, updated_at: null, rows: [], path };
  }
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text) as {
      updated_at?: string;
      rows?: TrajectoryRow[];
    };
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    if (rows.length === 0) {
      return { empty: true, hint: HINT, updated_at: raw.updated_at ?? null, rows, path };
    }
    return {
      empty: false,
      hint: null,
      updated_at: raw.updated_at ?? null,
      rows,
      path,
    };
  } catch {
    return { empty: true, hint: HINT, updated_at: null, rows: [], path };
  }
}

async function readLessonsPayload(): Promise<{
  empty: boolean;
  hint: string | null;
  fallback_path: string;
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
  const empty = mapped.length === 0;
  return {
    empty,
    hint: empty ? HINT : null,
    fallback_path: semanticFallbackPath(),
    usable,
    pending,
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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

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

  if (req.method === "GET" && path === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      trajectory_path: trajectoryPath(),
      semantic_fallback: semanticFallbackPath(),
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
        lessons: semanticFallbackPath(),
        note: "Polls stores read-only; run npm run tools + npm run replay:demo for data",
      }),
    );
  });

  const shutdown = async () => {
    await closeSemanticMemory().catch(() => undefined);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (err) => {
  console.error(err);
  await closeSemanticMemory().catch(() => undefined);
  process.exit(1);
});
