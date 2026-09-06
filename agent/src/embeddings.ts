/**
 * Text → embedding vector for episodic memory.
 *
 * Priority:
 *   1. EMBEDDING_BASE_URL (+ optional key) — OpenAI-compatible /v1/embeddings
 *   2. Local Ollama when reachable (nomic-embed-text by default)
 *   3. Offline bag-of-words hash (hash-bow-256) — never blocks demos
 *
 * API / Ollama failures fall back to offline.
 */

import OpenAI from "openai";
import { withSpan } from "./observability.js";

/** Fixed dim for offline hash embeddings (stable across runs). */
export const OFFLINE_EMBED_DIM = 256;

export type EmbedBackend = "offline" | "api" | "ollama";

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

function ollamaBaseUrl(): string {
  return (
    process.env.OLLAMA_BASE_URL ||
    process.env.OLLAMA_HOST ||
    "http://127.0.0.1:11434"
  ).replace(/\/+$/, "");
}

function ollamaEmbedModel(): string {
  return (
    process.env.EMBEDDING_MODEL ||
    process.env.OLLAMA_EMBED_MODEL ||
    "nomic-embed-text"
  ).trim();
}

/** Explicit OpenAI-compatible embed endpoint configured. */
export function embeddingApiConfigured(): boolean {
  return Boolean((process.env.EMBEDDING_BASE_URL || "").trim());
}

/** Prefer local Ollama embeds unless EMBEDDING_FORCE_OFFLINE=1. */
export function ollamaEmbedEnabled(): boolean {
  if (/^(1|true|yes|on)$/i.test(process.env.EMBEDDING_FORCE_OFFLINE || "")) {
    return false;
  }
  if (/^(0|false|no|off)$/i.test(process.env.EMBEDDING_USE_OLLAMA || "1")) {
    return false;
  }
  return true;
}

async function openAiCompatibleEmbed(
  text: string,
  opts: { baseURL: string; apiKey: string; model: string; backend: EmbedBackend },
): Promise<EmbeddingResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL.replace(/\/+$/, ""),
  });
  const res = await client.embeddings.create({
    model: opts.model,
    input: text,
  });
  const vector = res.data[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error("empty embedding response");
  }
  return {
    vector: l2Normalize(vector),
    backend: opts.backend,
    model: opts.model,
  };
}

async function apiEmbed(text: string): Promise<EmbeddingResult> {
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const baseURL = process.env.EMBEDDING_BASE_URL!;
  const apiKey =
    (process.env.EMBEDDING_API_KEY || "").trim() || "local-embeddings";
  return openAiCompatibleEmbed(text, {
    baseURL,
    apiKey,
    model,
    backend: "api",
  });
}

async function ollamaEmbed(text: string): Promise<EmbeddingResult> {
  const model = ollamaEmbedModel();
  const base = ollamaBaseUrl();
  // Prefer OpenAI-compat /v1/embeddings; fall back to native /api/embeddings.
  try {
    return await openAiCompatibleEmbed(text, {
      baseURL: `${base}/v1`,
      apiKey: (process.env.EMBEDDING_API_KEY || "").trim() || "ollama",
      model,
      backend: "ollama",
    });
  } catch (openaiErr) {
    const res = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(
        `ollama native embed ${res.status}: ${openaiErr instanceof Error ? openaiErr.message : openaiErr}`,
      );
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!json.embedding?.length) {
      throw new Error("empty ollama native embedding");
    }
    return {
      vector: l2Normalize(json.embedding),
      backend: "ollama",
      model,
    };
  }
}

function offlineResult(text: string): EmbeddingResult {
  return {
    vector: offlineEmbed(text),
    backend: "offline",
    model: `hash-bow-${OFFLINE_EMBED_DIM}`,
  };
}

/**
 * Embed text. Uses configured API, else local Ollama, else offline hash.
 * Never throws — falls back so demos never block on embed infra.
 */
export async function embedText(text: string): Promise<EmbeddingResult> {
  return withSpan(
    {
      kind: "EMBEDDING",
      name: "embedText",
    },
    async (input) => {
      if (embeddingApiConfigured()) {
        try {
          const out = await apiEmbed(input);
          console.log(
            JSON.stringify({
              type: "embed_ok",
              backend: out.backend,
              model: out.model,
              dim: out.vector.length,
            }),
          );
          return out;
        } catch (err) {
          console.log(
            JSON.stringify({
              type: "embed_fallback",
              from: "api",
              reason: err instanceof Error ? err.message : String(err),
              next: ollamaEmbedEnabled() ? "ollama" : "offline",
            }),
          );
        }
      }

      if (ollamaEmbedEnabled()) {
        try {
          const out = await ollamaEmbed(input);
          console.log(
            JSON.stringify({
              type: "embed_ok",
              backend: out.backend,
              model: out.model,
              dim: out.vector.length,
            }),
          );
          return out;
        } catch (err) {
          console.log(
            JSON.stringify({
              type: "embed_fallback",
              from: "ollama",
              reason: err instanceof Error ? err.message : String(err),
              next: "offline",
            }),
          );
        }
      }

      const out = offlineResult(input);
      console.log(
        JSON.stringify({
          type: "embed_ok",
          backend: out.backend,
          model: out.model,
          dim: out.vector.length,
        }),
      );
      return out;
    },
    text,
  );
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
