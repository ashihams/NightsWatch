/**
 * Text → embedding vector.
 *
 * Default (hackathon / free-tier): deterministic bag-of-words hash embedding —
 * no API key, works fully offline.
 *
 * Optional: OpenAI-compatible embeddings when EMBEDDING_BASE_URL + EMBEDDING_API_KEY
 * are set (TensorMux or another gateway). On API failure, falls back to offline.
 */

import OpenAI from "openai";

/** Fixed dim for offline hash embeddings (stable across runs). */
export const OFFLINE_EMBED_DIM = 256;

export type EmbedBackend = "offline" | "api";

export type EmbeddingResult = {
  vector: number[];
  backend: EmbedBackend;
  model: string;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** FNV-1a style hash → bucket index. */
function tokenHash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
}

/**
 * Deterministic bag-of-words / hashing-trick embedding.
 * Same text → same vector; similar token overlap → higher cosine similarity.
 */
export function offlineEmbed(text: string, dim = OFFLINE_EMBED_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    vec[0] = 1;
    return l2Normalize(vec);
  }
  for (const tok of tokens) {
    const h = tokenHash(tok);
    const idx = h % dim;
    const sign = h & 1 ? 1 : -1;
    vec[idx] += sign;
  }
  return l2Normalize(vec);
}

export function embeddingApiConfigured(): boolean {
  const base = (process.env.EMBEDDING_BASE_URL || "").trim();
  const key = (process.env.EMBEDDING_API_KEY || "").trim();
  return Boolean(base && key);
}

async function apiEmbed(text: string): Promise<EmbeddingResult> {
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const client = new OpenAI({
    apiKey: process.env.EMBEDDING_API_KEY!,
    baseURL: process.env.EMBEDDING_BASE_URL!,
  });
  const res = await client.embeddings.create({ model, input: text });
  const vector = res.data[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error("empty embedding response");
  }
  return { vector: l2Normalize(vector), backend: "api", model };
}

/**
 * Embed text. Uses API when configured; otherwise offline hash embedding.
 * API errors fall back to offline so demos never block on embed keys.
 */
export async function embedText(text: string): Promise<EmbeddingResult> {
  if (embeddingApiConfigured()) {
    try {
      return await apiEmbed(text);
    } catch (err) {
      console.log(
        JSON.stringify({
          type: "embed_fallback",
          reason: err instanceof Error ? err.message : String(err),
          backend: "offline",
        }),
      );
    }
  }
  return {
    vector: offlineEmbed(text),
    backend: "offline",
    model: `hash-bow-${OFFLINE_EMBED_DIM}`,
  };
}

/** Cosine similarity for L2-normalized (or raw) vectors; returns 0 if dims differ. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
