/**
 * Episodic memory — local SQLite vector store (no Neo4j, no hosted vector DB).
 *
 * Choice: SQLite + JSON float embeddings + in-process cosine search.
 * Fastest free-tier / zero-infra option for the hackathon; pairs with
 * offline bag-of-words embeddings so demos work without paid embed APIs.
 *
 * Path via EPISODIC_DB_PATH (default ./data/episodic.sqlite).
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  cosineSimilarity,
  embedText,
  type EmbedBackend,
} from "./embeddings.js";

export type EpisodeRow = {
  id: string;
  run_id: string;
  situation_summary: string;
  embedding: number[];
  embed_backend: EmbedBackend;
  embed_model: string;
  tool_sequence: string[];
  success: boolean;
  tool_call_count: number;
  token_count: number;
  latency_ms: number;
  created_at: string;
};

export type EpisodeMatch = EpisodeRow & {
  similarity: number;
};

export type WriteEpisodeInput = {
  run_id: string;
  situation_summary: string;
  tool_sequence: string[];
  success: boolean;
  tool_call_count: number;
  token_count?: number;
  latency_ms: number;
};

let db: DatabaseSync | null = null;

function episodicDbPath(): string {
  return resolve(
    process.cwd(),
    process.env.EPISODIC_DB_PATH || "./data/episodic.sqlite",
  );
}

function getDb(): DatabaseSync {
  if (db) return db;

  const path = episodicDbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      situation_summary TEXT NOT NULL,
      embedding TEXT NOT NULL,
      embed_backend TEXT NOT NULL,
      embed_model TEXT NOT NULL,
      tool_sequence TEXT NOT NULL,
      success INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_created_at ON episodes(created_at);
    CREATE INDEX IF NOT EXISTS idx_episodes_run_id ON episodes(run_id);
  `);
  return db;
}

function parseEpisode(row: Record<string, unknown>): EpisodeRow {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    situation_summary: String(row.situation_summary),
    embedding: JSON.parse(String(row.embedding || "[]")) as number[],
    embed_backend: String(row.embed_backend) as EmbedBackend,
    embed_model: String(row.embed_model),
    tool_sequence: JSON.parse(String(row.tool_sequence || "[]")) as string[],
    success: Boolean(Number(row.success)),
    tool_call_count: Number(row.tool_call_count),
    token_count: Number(row.token_count ?? 0),
    latency_ms: Number(row.latency_ms),
    created_at: String(row.created_at),
  };
}

/** Build a short NL situation string to embed (task + tools + outcome). */
export function buildSituationSummary(
  task: string,
  toolSequence: string[],
  success: boolean,
): string {
  const tools =
    toolSequence.length > 0 ? toolSequence.join(" → ") : "(none)";
  return `Task: ${task}. Tools: ${tools}. Outcome: ${success ? "success" : "failed"}.`;
}

/** Unconditionally write one episode after a planner run ends. */
export async function writeEpisode(
  input: WriteEpisodeInput,
): Promise<EpisodeRow> {
  const { vector, backend, model } = await embedText(input.situation_summary);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const row: EpisodeRow = {
    id,
    run_id: input.run_id,
    situation_summary: input.situation_summary,
    embedding: vector,
    embed_backend: backend,
    embed_model: model,
    tool_sequence: input.tool_sequence,
    success: input.success,
    tool_call_count: input.tool_call_count,
    token_count: input.token_count ?? 0,
    latency_ms: input.latency_ms,
    created_at: createdAt,
  };

  getDb()
    .prepare(
      `INSERT INTO episodes
        (id, run_id, situation_summary, embedding, embed_backend, embed_model,
         tool_sequence, success, tool_call_count, token_count, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.run_id,
      row.situation_summary,
      JSON.stringify(row.embedding),
      row.embed_backend,
      row.embed_model,
      JSON.stringify(row.tool_sequence),
      row.success ? 1 : 0,
      row.tool_call_count,
      row.token_count,
      row.latency_ms,
      row.created_at,
    );

  console.log(
    JSON.stringify({
      type: "episodic_write",
      id: row.id,
      run_id: row.run_id,
      embed_backend: row.embed_backend,
      embed_model: row.embed_model,
      success: row.success,
      tool_call_count: row.tool_call_count,
      situation_summary: row.situation_summary,
    }),
  );

  return row;
}

/**
 * Retrieval API: top-k nearest episodes by embedding cosine similarity.
 * Only compares against episodes with the same embed backend/dim.
 */
export async function retrieveEpisodes(
  task: string,
  k = 3,
): Promise<EpisodeMatch[]> {
  const limit = Number.isFinite(k) && k > 0 ? Math.floor(k) : 3;
  const { vector, backend, model } = await embedText(task);

  const rows = getDb()
    .prepare(
      `SELECT id, run_id, situation_summary, embedding, embed_backend, embed_model,
              tool_sequence, success, tool_call_count, token_count, latency_ms, created_at
       FROM episodes
       WHERE embed_backend = ?
       ORDER BY created_at DESC`,
    )
    .all(backend) as Record<string, unknown>[];

  const scored: EpisodeMatch[] = [];
  for (const raw of rows) {
    const ep = parseEpisode(raw);
    if (ep.embedding.length !== vector.length) continue;
    scored.push({
      ...ep,
      similarity: cosineSimilarity(vector, ep.embedding),
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, limit);

  console.log(
    JSON.stringify({
      type: "episodic_retrieve",
      query: task,
      k: limit,
      embed_backend: backend,
      embed_model: model,
      hit_count: top.length,
      hits: top.map((h) => ({
        run_id: h.run_id,
        id: h.id,
        similarity: Number(h.similarity.toFixed(4)),
        success: h.success,
        situation_summary: h.situation_summary,
      })),
    }),
  );

  return top;
}

/** Soft-context objects stored in working_runs.injected_context. */
export function episodesToInjectedContext(
  matches: EpisodeMatch[],
): Array<Record<string, unknown>> {
  return matches.map((m) => ({
    type: "episodic",
    episode_id: m.id,
    run_id: m.run_id,
    situation_summary: m.situation_summary,
    tool_sequence: m.tool_sequence,
    success: m.success,
    similarity: Number(m.similarity.toFixed(4)),
  }));
}

/** Recent episodes newest-first (for inspect script). */
export function listEpisodes(limit = 20): EpisodeRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, run_id, situation_summary, embedding, embed_backend, embed_model,
              tool_sequence, success, tool_call_count, token_count, latency_ms, created_at
       FROM episodes
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(parseEpisode);
}

export function episodicMemoryDbPath(): string {
  return episodicDbPath();
}
