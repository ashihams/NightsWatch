/**
 * Semantic memory (Step 7): Neo4j graph of Runs / Situations / Factors / Lessons / Tools.
 *
 * Connect via NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD (AuraDB-friendly).
 * If Neo4j is unset or unreachable: degrade gracefully to a local JSON store
 * (SEMANTIC_FALLBACK_PATH, default ./data/semantic_lessons.json) — never crash the agent.
 *
 * Evidence gate: evidence_count=1 → candidate (not usable);
 * evidence_count>=2 → promoted (usable) with confidence set.
 * Planner injection of usable lessons is Step 8 — this module only stores.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { CandidateLesson } from "./reflection.js";
import { toolDescription } from "./reflection.js";

export type StoredLesson = {
  id: string;
  text: string;
  confidence: number;
  evidence_count: number;
  created_at: string;
  usable: boolean;
  tool: string;
  condition: string;
  factors: string[];
  situation_id: string;
  supporting_run_ids: string[];
  backend: "neo4j" | "local_fallback";
};

export type StoreLessonResult = {
  lesson: StoredLesson;
  promoted: boolean;
  /** true when this run newly supported the lesson */
  newly_supported: boolean;
  backend: "neo4j" | "local_fallback";
};

export type RunSnapshot = {
  id: string;
  task: string;
  started_at: string;
  success: boolean;
  tool_calls: number;
  tokens: number;
  latency_ms: number;
};

type LocalStore = {
  runs: Record<string, RunSnapshot>;
  lessons: Record<string, StoredLesson>;
};

let driver: Driver | null = null;
let schemaReady = false;
let neo4jUnavailableLogged = false;
let preferLocal = false;

function neo4jConfigured(): boolean {
  const uri = (process.env.NEO4J_URI || "").trim();
  const user = (process.env.NEO4J_USER || "").trim();
  const password = (process.env.NEO4J_PASSWORD || "").trim();
  return Boolean(uri && user && password);
}

function fallbackPath(): string {
  return resolve(
    process.cwd(),
    process.env.SEMANTIC_FALLBACK_PATH || "./data/semantic_lessons.json",
  );
}

function confidenceFor(evidenceCount: number): number {
  if (evidenceCount < 2) return 0;
  return Math.round(Math.min(0.55 + 0.15 * (evidenceCount - 1), 0.95) * 100) / 100;
}

function loadLocal(): LocalStore {
  const path = fallbackPath();
  if (!existsSync(path)) {
    return { runs: {}, lessons: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LocalStore;
    return {
      runs: raw.runs || {},
      lessons: raw.lessons || {},
    };
  } catch {
    return { runs: {}, lessons: {} };
  }
}

function saveLocal(store: LocalStore): void {
  const path = fallbackPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function getDriver(): Driver | null {
  if (preferLocal || !neo4jConfigured()) return null;
  if (driver) return driver;
  try {
    driver = neo4j.driver(
      process.env.NEO4J_URI!.trim(),
      neo4j.auth.basic(
        process.env.NEO4J_USER!.trim(),
        process.env.NEO4J_PASSWORD!.trim(),
      ),
    );
    return driver;
  } catch (err) {
    warnNeo4j("driver_create_failed", err);
    preferLocal = true;
    return null;
  }
}

function warnNeo4j(reason: string, err?: unknown): void {
  if (neo4jUnavailableLogged) return;
  neo4jUnavailableLogged = true;
  console.warn(
    `[semantic-memory] Neo4j unavailable (${reason}) — using local fallback store at ${fallbackPath()}`,
    err instanceof Error ? err.message : err || "",
  );
}

async function withSession<T>(
  fn: (session: Session) => Promise<T>,
): Promise<T | null> {
  const d = getDriver();
  if (!d) return null;
  const session = d.session();
  try {
    return await fn(session);
  } catch (err) {
    warnNeo4j("session_error", err);
    preferLocal = true;
    try {
      await d.close();
    } catch {
      // ignore
    }
    driver = null;
    return null;
  } finally {
    try {
      await session.close();
    } catch {
      // ignore
    }
  }
}

async function ensureSchema(): Promise<boolean> {
  if (schemaReady) return true;
  const ok = await withSession(async (session) => {
    const stmts = [
      "CREATE CONSTRAINT run_id IF NOT EXISTS FOR (r:Run) REQUIRE r.id IS UNIQUE",
      "CREATE CONSTRAINT situation_id IF NOT EXISTS FOR (s:Situation) REQUIRE s.id IS UNIQUE",
      "CREATE CONSTRAINT lesson_id IF NOT EXISTS FOR (l:Lesson) REQUIRE l.id IS UNIQUE",
      "CREATE CONSTRAINT factor_name IF NOT EXISTS FOR (f:Factor) REQUIRE f.name IS UNIQUE",
      "CREATE CONSTRAINT tool_name IF NOT EXISTS FOR (t:Tool) REQUIRE t.name IS UNIQUE",
      "CREATE INDEX lesson_usable IF NOT EXISTS FOR (l:Lesson) ON (l.usable)",
    ];
    for (const cypher of stmts) {
      await session.run(cypher);
    }
    // Connectivity probe
    await session.run("RETURN 1 AS ok");
    return true;
  });
  if (ok) {
    schemaReady = true;
    console.log(
      JSON.stringify({
        type: "semantic_memory_backend",
        backend: "neo4j",
        uri: (process.env.NEO4J_URI || "").replace(/\/\/.*@/, "//***@"),
      }),
    );
    return true;
  }
  return false;
}

function storeLocal(
  run: RunSnapshot,
  candidate: CandidateLesson,
): StoreLessonResult {
  const store = loadLocal();
  store.runs[run.id] = run;

  const existing = store.lessons[candidate.lesson_id];
  let newly_supported = true;
  let supporting = existing?.supporting_run_ids
    ? [...existing.supporting_run_ids]
    : [];

  if (supporting.includes(run.id)) {
    newly_supported = false;
  } else {
    supporting.push(run.id);
  }

  // Merge any explicit supporting ids from the candidate (dedupe)
  for (const id of candidate.supporting_run_ids) {
    if (!supporting.includes(id)) supporting.push(id);
  }

  const evidence_count = supporting.length;
  const usable = evidence_count >= 2;
  const confidence = confidenceFor(evidence_count);
  const created_at = existing?.created_at || new Date().toISOString();

  const lesson: StoredLesson = {
    id: candidate.lesson_id,
    text: candidate.lesson_text,
    confidence,
    evidence_count,
    created_at,
    usable,
    tool: candidate.tool,
    condition: candidate.condition,
    factors: candidate.factors,
    situation_id: candidate.situation_id,
    supporting_run_ids: supporting,
    backend: "local_fallback",
  };

  const wasUsable = Boolean(existing?.usable);
  store.lessons[candidate.lesson_id] = lesson;
  saveLocal(store);

  return {
    lesson,
    promoted: usable && !wasUsable,
    newly_supported,
    backend: "local_fallback",
  };
}

async function storeNeo4j(
  run: RunSnapshot,
  candidate: CandidateLesson,
): Promise<StoreLessonResult | null> {
  const schemaOk = await ensureSchema();
  if (!schemaOk) return null;

  const result = await withSession(async (session) => {
    const now = new Date().toISOString();
    const cypher = `
      MERGE (r:Run {id: $runId})
      SET r.task = $task,
          r.started_at = $startedAt,
          r.success = $success,
          r.tool_calls = $toolCalls,
          r.tokens = $tokens,
          r.latency_ms = $latencyMs

      MERGE (s:Situation {id: $situationId})
      ON CREATE SET s.description = $situationDescription
      SET s.description = coalesce(s.description, $situationDescription)

      MERGE (r)-[:ENCOUNTERED]->(s)

      WITH r, s
      UNWIND $factors AS fname
      MERGE (f:Factor {name: fname})
      MERGE (s)-[:HAS_FACTOR]->(f)

      WITH DISTINCT r, s
      MERGE (l:Lesson {id: $lessonId})
      ON CREATE SET
        l.text = $lessonText,
        l.confidence = 0.0,
        l.evidence_count = 0,
        l.created_at = $now,
        l.usable = false,
        l.condition = $condition
      SET l.text = $lessonText,
          l.condition = $condition

      MERGE (s)-[:RESOLVED_BY]->(l)

      MERGE (t:Tool {name: $toolName})
      SET t.description = $toolDescription
      MERGE (l)-[:APPLIES_TO]->(t)

      WITH l, r
      OPTIONAL MATCH (l)-[existing:SUPPORTED_BY]->(r)
      WITH l, r, existing
      FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
        MERGE (l)-[:SUPPORTED_BY]->(r)
      )

      WITH l
      OPTIONAL MATCH (l)-[:SUPPORTED_BY]->(supportRun:Run)
      WITH l, collect(DISTINCT supportRun.id) AS supportIds
      WITH l, supportIds, size(supportIds) AS cnt
      SET l.evidence_count = cnt,
          l.confidence = CASE
            WHEN cnt < 2 THEN 0.0
            WHEN cnt = 2 THEN 0.7
            WHEN cnt = 3 THEN 0.85
            ELSE 0.95
          END,
          l.usable = cnt >= 2
      RETURN l.id AS id,
             l.text AS text,
             l.confidence AS confidence,
             l.evidence_count AS evidence_count,
             l.created_at AS created_at,
             l.usable AS usable,
             l.condition AS condition,
             supportIds AS supporting_run_ids
    `;

    const res = await session.run(cypher, {
      runId: run.id,
      task: run.task,
      startedAt: run.started_at,
      success: run.success,
      toolCalls: neo4j.int(run.tool_calls),
      tokens: neo4j.int(run.tokens),
      latencyMs: neo4j.int(Math.round(run.latency_ms)),
      situationId: candidate.situation_id,
      situationDescription: candidate.condition,
      factors: candidate.factors,
      lessonId: candidate.lesson_id,
      lessonText: candidate.lesson_text,
      now,
      condition: candidate.condition,
      toolName: candidate.tool,
      toolDescription: toolDescription(candidate.tool),
    });

    const row = res.records[0];
    if (!row) {
      throw new Error("Neo4j upsert returned no lesson row");
    }

    const evidence_count = neo4j.isInt(row.get("evidence_count"))
      ? row.get("evidence_count").toNumber()
      : Number(row.get("evidence_count"));
    const confidence = Number(row.get("confidence") || 0);
    const usable = Boolean(row.get("usable"));
    const supporting_run_ids = (row.get("supporting_run_ids") || []).map(String);

    // Factors for listing — re-read
    const factorRes = await session.run(
      `
      MATCH (l:Lesson {id: $id})<-[:RESOLVED_BY]-(s:Situation)-[:HAS_FACTOR]->(f:Factor)
      RETURN collect(DISTINCT f.name) AS factors
      `,
      { id: candidate.lesson_id },
    );
    const factors =
      factorRes.records[0]?.get("factors")?.map(String) || candidate.factors;

    const lesson: StoredLesson = {
      id: String(row.get("id")),
      text: String(row.get("text")),
      confidence,
      evidence_count,
      created_at: String(row.get("created_at") || now),
      usable,
      tool: candidate.tool,
      condition: String(row.get("condition") || candidate.condition),
      factors,
      situation_id: candidate.situation_id,
      supporting_run_ids,
      backend: "neo4j",
    };

    return {
      lesson,
      promoted: usable && evidence_count >= 2,
      newly_supported: supporting_run_ids.includes(run.id),
      backend: "neo4j" as const,
    };
  });

  return result;
}

/**
 * Upsert run + candidate lesson; bump evidence when a new run supports the same lesson.
 */
export async function storeCandidateLesson(params: {
  run: RunSnapshot;
  candidate: CandidateLesson;
}): Promise<StoreLessonResult> {
  if (neo4jConfigured() && !preferLocal) {
    try {
      const neo = await storeNeo4j(params.run, params.candidate);
      if (neo) {
        // "promoted" = crossed the evidence gate on this write
        const justPromoted =
          neo.lesson.usable &&
          neo.newly_supported &&
          neo.lesson.evidence_count === 2;
        return {
          ...neo,
          promoted: justPromoted,
        };
      }
    } catch (err) {
      warnNeo4j("store_failed", err);
    }
  } else if (!neo4jConfigured() && !neo4jUnavailableLogged) {
    console.warn(
      `[semantic-memory] NEO4J_URI/USER/PASSWORD unset — using local fallback store at ${fallbackPath()}`,
    );
    neo4jUnavailableLogged = true;
  }

  return storeLocal(params.run, params.candidate);
}

/** List all lessons (candidates + usable). Prefer Neo4j when healthy. */
export async function listLessons(): Promise<StoredLesson[]> {
  if (neo4jConfigured() && !preferLocal) {
    const schemaOk = await ensureSchema();
    if (schemaOk) {
      const rows = await withSession(async (session) => {
        const res = await session.run(`
          MATCH (l:Lesson)
          OPTIONAL MATCH (l)-[:APPLIES_TO]->(t:Tool)
          OPTIONAL MATCH (l)<-[:RESOLVED_BY]-(s:Situation)
          OPTIONAL MATCH (s)-[:HAS_FACTOR]->(f:Factor)
          OPTIONAL MATCH (l)-[:SUPPORTED_BY]->(r:Run)
          RETURN l.id AS id,
                 l.text AS text,
                 l.confidence AS confidence,
                 l.evidence_count AS evidence_count,
                 l.created_at AS created_at,
                 l.usable AS usable,
                 l.condition AS condition,
                 coalesce(t.name, '') AS tool,
                 coalesce(s.id, '') AS situation_id,
                 collect(DISTINCT f.name) AS factors,
                 collect(DISTINCT r.id) AS supporting_run_ids
          ORDER BY l.created_at ASC
        `);
        return res.records.map((row) => {
          const evidence_count = neo4j.isInt(row.get("evidence_count"))
            ? row.get("evidence_count").toNumber()
            : Number(row.get("evidence_count") || 0);
          return {
            id: String(row.get("id")),
            text: String(row.get("text")),
            confidence: Number(row.get("confidence") || 0),
            evidence_count,
            created_at: String(row.get("created_at") || ""),
            usable: Boolean(row.get("usable")),
            tool: String(row.get("tool") || ""),
            condition: String(row.get("condition") || ""),
            factors: (row.get("factors") || []).map(String).filter(Boolean),
            situation_id: String(row.get("situation_id") || ""),
            supporting_run_ids: (row.get("supporting_run_ids") || [])
              .map(String)
              .filter(Boolean),
            backend: "neo4j" as const,
          };
        });
      });
      if (rows) return rows;
    }
  }

  const store = loadLocal();
  return Object.values(store.lessons).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
}

/** Usable lessons only (evidence_count >= 2). For Step 8 injection. */
export async function listUsableLessons(): Promise<StoredLesson[]> {
  const all = await listLessons();
  return all.filter((l) => l.usable && l.evidence_count >= 2);
}

export async function closeSemanticMemory(): Promise<void> {
  if (driver) {
    try {
      await driver.close();
    } catch {
      // ignore
    }
    driver = null;
  }
  schemaReady = false;
}

export function semanticFallbackPath(): string {
  return fallbackPath();
}

/** Test helper: clear local fallback store. */
export function clearLocalSemanticStore(): void {
  const path = fallbackPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ runs: {}, lessons: {} }, null, 2)}\n`, "utf8");
}
