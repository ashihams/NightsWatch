/**
 * Local pending_reflection records for Step 7 (reflection LLM) to consume.
 * JSON files under PENDING_REFLECTION_DIR (default ./data/pending_reflection).
 * No reflection LLM / Neo4j writes here.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { AnalyzeRunResult } from "./analyzer.js";

export type PendingReflectionRecord = {
  status: "pending";
  run_id: string;
  task: string;
  created_at: string;
  source: "neatlogs" | "working_memory";
  flagged: true;
  triggers: string[];
  evidence: Record<string, unknown>;
  mode?: string;
  final_message?: string;
};

function pendingDir(): string {
  return resolve(
    process.cwd(),
    process.env.PENDING_REFLECTION_DIR || "./data/pending_reflection",
  );
}

export function pendingReflectionDir(): string {
  return pendingDir();
}

/** Write one pending_reflection JSON file. Returns absolute path. */
export function writePendingReflection(params: {
  runId: string;
  task: string;
  source: "neatlogs" | "working_memory";
  analysis: AnalyzeRunResult;
  mode?: string;
  finalMessage?: string;
}): string {
  if (!params.analysis.flagged) {
    throw new Error("writePendingReflection requires flagged=true");
  }

  const dir = pendingDir();
  mkdirSync(dir, { recursive: true });

  const record: PendingReflectionRecord = {
    status: "pending",
    run_id: params.runId,
    task: params.task,
    created_at: new Date().toISOString(),
    source: params.source,
    flagged: true,
    triggers: params.analysis.triggers,
    evidence: params.analysis.evidence,
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.finalMessage ? { final_message: params.finalMessage } : {}),
  };

  const path = join(dir, `${params.runId}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

/** List pending reflection JSON filenames (for inspect). */
export function listPendingReflectionFiles(): string[] {
  const dir = pendingDir();
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

export function readPendingReflection(
  runId: string,
): PendingReflectionRecord | null {
  try {
    const raw = readFileSync(join(pendingDir(), `${runId}.json`), "utf8");
    return JSON.parse(raw) as PendingReflectionRecord;
  } catch {
    return null;
  }
}
