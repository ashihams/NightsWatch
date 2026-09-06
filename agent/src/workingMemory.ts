/**
 * Minimal SQLite working memory — one in-flight (or recent) planner run.
 *
 * No episodic/semantic memory, no reflection. Path via WORKING_DB_PATH
 * (default ./data/working.sqlite).
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ToolCallResult } from "./tools.js";

export type WorkingRunStatus = "in_progress" | "complete" | "failed";

export type WorkingRunRow = {
  run_id: string;
  task_description: string;
  status: WorkingRunStatus;
  started_at: string;
  current_step: number;
  tool_call_log: unknown[];
  injected_context: unknown;
};

let db: DatabaseSync | null = null;

function workingDbPath(): string {
  return resolve(process.cwd(), process.env.WORKING_DB_PATH || "./data/working.sqlite");
}

function getDb(): DatabaseSync {
  if (db) return db;

  const path = workingDbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_runs (
      run_id TEXT PRIMARY KEY,
      task_description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'complete', 'failed')),
      started_at TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0,
      tool_call_log TEXT NOT NULL DEFAULT '[]',
      injected_context TEXT NOT NULL DEFAULT '[]'
    )
  `);
  return db;
}

function parseRow(row: Record<string, unknown>): WorkingRunRow {
  return {
    run_id: String(row.run_id),
    task_description: String(row.task_description),
    status: row.status as WorkingRunStatus,
    started_at: String(row.started_at),
    current_step: Number(row.current_step),
    tool_call_log: JSON.parse(String(row.tool_call_log || "[]")),
    injected_context: JSON.parse(String(row.injected_context || "[]")),
  };
}

/** Insert a new in-progress run; returns run_id. */
export function startWorkingRun(taskDescription: string): string {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO working_runs
        (run_id, task_description, status, started_at, current_step, tool_call_log, injected_context)
       VALUES (?, ?, 'in_progress', ?, 0, '[]', '[]')`,
    )
    .run(runId, taskDescription, startedAt);
  return runId;
}

/** Append one tool call and bump current_step. */
export function appendToolCall(runId: string, toolCall: ToolCallResult): void {
  const row = getDb()
    .prepare(`SELECT tool_call_log, current_step FROM working_runs WHERE run_id = ?`)
    .get(runId) as { tool_call_log: string; current_step: number } | undefined;

  if (!row) {
    throw new Error(`working_runs row not found: ${runId}`);
  }

  const log = JSON.parse(row.tool_call_log || "[]") as unknown[];
  log.push({
    name: toolCall.name,
    args: toolCall.args,
    status: toolCall.status,
    ok: toolCall.ok,
    latency_ms: toolCall.latencyMs,
    body: toolCall.body,
  });
  const nextStep = Number(row.current_step) + 1;

  getDb()
    .prepare(
      `UPDATE working_runs
       SET tool_call_log = ?, current_step = ?
       WHERE run_id = ?`,
    )
    .run(JSON.stringify(log), nextStep, runId);
}

/** Mark run complete or failed. */
export function finishWorkingRun(
  runId: string,
  status: "complete" | "failed",
): void {
  getDb()
    .prepare(`UPDATE working_runs SET status = ? WHERE run_id = ?`)
    .run(status, runId);
}

/** Replace injected_context JSON for a run (semantic lessons and/or episodic soft context). */
export function setInjectedContext(
  runId: string,
  context: unknown[],
): void {
  getDb()
    .prepare(`UPDATE working_runs SET injected_context = ? WHERE run_id = ?`)
    .run(JSON.stringify(context), runId);
}

/** Read injected_context for a run. */
export function getInjectedContext(runId: string): unknown[] {
  const row = getDb()
    .prepare(`SELECT injected_context FROM working_runs WHERE run_id = ?`)
    .get(runId) as { injected_context: string } | undefined;
  if (!row) {
    throw new Error(`working_runs row not found: ${runId}`);
  }
  const parsed = JSON.parse(String(row.injected_context || "[]"));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * True when injected_context already has semantic lessons (Step 8 strategy injection).
 * When true, episodic retrieval is skipped.
 */
export function hasSemanticLessons(context: unknown): boolean {
  if (!Array.isArray(context)) return false;
  return context.some(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      (item as { type?: string }).type === "semantic_lesson",
  );
}

/** Fetch one working_runs row by id (null if missing). */
export function getWorkingRun(runId: string): WorkingRunRow | null {
  const row = getDb()
    .prepare(
      `SELECT run_id, task_description, status, started_at, current_step,
              tool_call_log, injected_context
       FROM working_runs
       WHERE run_id = ?`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  return row ? parseRow(row) : null;
}

/** Recent runs newest-first (for inspect script). */
export function listWorkingRuns(limit = 20): WorkingRunRow[] {
  const rows = getDb()
    .prepare(
      `SELECT run_id, task_description, status, started_at, current_step,
              tool_call_log, injected_context
       FROM working_runs
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(parseRow);
}

/** Optional: drop finished rows to keep the table small. */
export function clearCompletedRuns(): number {
  const result = getDb()
    .prepare(`DELETE FROM working_runs WHERE status IN ('complete', 'failed')`)
    .run();
  return Number(result.changes ?? 0);
}

export function workingMemoryDbPath(): string {
  return workingDbPath();
}
