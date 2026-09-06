/**
 * Strategy injection (Step 8): retrieve usable semantic lessons and prepare
 * soft context for the planner.
 *
 * Retrieval paths:
 * 1. Direct match — usable lessons whose situation/tool factors strongly overlap
 *    the current task factors (and meet confidence threshold).
 * 2. Shared-factor traversal — if no strong direct match, rank usable lessons by
 *    shared-factor count (via Neo4j graph or local equivalent) and take top-k.
 *
 * Candidates (evidence_count < 2 / usable=false) are never returned.
 */

import { expandFactors, extractFactors, type FactorExtraction } from "./factors.js";
import {
  listUsableLessons,
  type StoredLesson,
} from "./semanticMemory.js";

export type RetrievalPath = "direct" | "shared_factor" | "none";

export type RetrievedLesson = {
  lesson: StoredLesson;
  shared_factor_count: number;
  matched_factors: string[];
  path: "direct" | "shared_factor";
};

export type StrategyRetrieval = {
  factors: FactorExtraction;
  /** Expanded set used for matching (includes aliases). */
  query_factors: string[];
  path: RetrievalPath;
  lessons: RetrievedLesson[];
  min_confidence: number;
  direct_threshold: number;
};

export type SemanticLessonInjected = {
  type: "semantic_lesson";
  lesson_id: string;
  text: string;
  confidence: number;
  evidence_count: number;
  factors: string[];
  tool: string;
  retrieval_path: "direct" | "shared_factor";
  shared_factor_count: number;
  matched_factors: string[];
};

function minConfidence(): number {
  const n = Number(process.env.STRATEGY_MIN_CONFIDENCE || 0.55);
  return Number.isFinite(n) && n >= 0 ? n : 0.55;
}

function directOverlapThreshold(): number {
  const n = Number(process.env.STRATEGY_DIRECT_OVERLAP || 0.5);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
}

function topK(): number {
  const n = Number(process.env.STRATEGY_TOP_K || 3);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

export function strategyInjectionEnabled(): boolean {
  const raw = (process.env.STRATEGY_INJECTION || "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function lessonFactorSet(lesson: StoredLesson): Set<string> {
  return new Set(
    (lesson.factors || []).map((f) => f.trim().toLowerCase()).filter(Boolean),
  );
}

function overlap(
  query: Set<string>,
  lessonFactors: Set<string>,
): { count: number; matched: string[] } {
  const matched: string[] = [];
  for (const f of query) {
    if (lessonFactors.has(f)) matched.push(f);
  }
  return { count: matched.length, matched };
}

function scoreLesson(
  lesson: StoredLesson,
  queryFactors: string[],
): RetrievedLesson | null {
  if (!lesson.usable || lesson.evidence_count < 2) return null;
  const q = new Set(queryFactors);
  const lf = lessonFactorSet(lesson);
  const { count, matched } = overlap(q, lf);
  if (count <= 0) return null;
  return {
    lesson,
    shared_factor_count: count,
    matched_factors: matched,
    path: "shared_factor", // refined by caller
  };
}

function isDirectMatch(
  hit: RetrievedLesson,
  queryFactorCount: number,
  threshold: number,
  minConf: number,
): boolean {
  if (hit.lesson.confidence < minConf) return false;
  if (queryFactorCount <= 0) return false;
  const ratio = hit.shared_factor_count / queryFactorCount;
  // Also treat full coverage of lesson factors (when lesson is small) as direct
  const lessonSize = Math.max(1, hit.lesson.factors.length);
  const lessonCoverage = hit.shared_factor_count / lessonSize;
  return ratio >= threshold || lessonCoverage >= threshold;
}

/**
 * Rank usable lessons by shared factors; split into direct vs shared-factor path.
 */
export async function retrieveStrategyLessons(params: {
  task: string;
  priorEpisodeSummaries?: string[];
}): Promise<StrategyRetrieval> {
  const factors = extractFactors(
    params.task,
    params.priorEpisodeSummaries || [],
  );
  const query_factors = expandFactors(factors.factors);
  const min_confidence = minConfidence();
  const direct_threshold = directOverlapThreshold();
  const k = topK();

  if (query_factors.length === 0) {
    return {
      factors,
      query_factors,
      path: "none",
      lessons: [],
      min_confidence,
      direct_threshold,
    };
  }

  const usable = await listUsableLessons();
  const scored: RetrievedLesson[] = [];
  for (const lesson of usable) {
    const hit = scoreLesson(lesson, query_factors);
    if (hit) scored.push(hit);
  }

  scored.sort((a, b) => {
    if (b.shared_factor_count !== a.shared_factor_count) {
      return b.shared_factor_count - a.shared_factor_count;
    }
    if (b.lesson.confidence !== a.lesson.confidence) {
      return b.lesson.confidence - a.lesson.confidence;
    }
    return b.lesson.evidence_count - a.lesson.evidence_count;
  });

  const direct = scored.filter((h) =>
    isDirectMatch(h, query_factors.length, direct_threshold, min_confidence),
  );

  if (direct.length > 0) {
    const lessons = direct.slice(0, k).map((h) => ({
      ...h,
      path: "direct" as const,
    }));
    return {
      factors,
      query_factors,
      path: "direct",
      lessons,
      min_confidence,
      direct_threshold,
    };
  }

  // Shared-factor traversal: any overlap, ranked by shared count (already sorted)
  const shared = scored
    .filter((h) => h.lesson.confidence >= min_confidence || h.shared_factor_count >= 1)
    .slice(0, k)
    .map((h) => ({ ...h, path: "shared_factor" as const }));

  // Prefer confidence-gated hits; if none meet min_confidence but we have
  // usable lessons with overlap, still return them (usable already implies gate).
  const lessons =
    shared.length > 0
      ? shared
      : scored.slice(0, k).map((h) => ({ ...h, path: "shared_factor" as const }));

  return {
    factors,
    query_factors,
    path: lessons.length > 0 ? "shared_factor" : "none",
    lessons,
    min_confidence,
    direct_threshold,
  };
}

export function lessonsToInjectedContext(
  retrieval: StrategyRetrieval,
): SemanticLessonInjected[] {
  return retrieval.lessons.map((hit) => ({
    type: "semantic_lesson" as const,
    lesson_id: hit.lesson.id,
    text: hit.lesson.text,
    confidence: hit.lesson.confidence,
    evidence_count: hit.lesson.evidence_count,
    factors: hit.lesson.factors,
    tool: hit.lesson.tool,
    retrieval_path: hit.path,
    shared_factor_count: hit.shared_factor_count,
    matched_factors: hit.matched_factors,
  }));
}

/** Pull semantic lesson entries from working_runs.injected_context. */
export function getInjectedSemanticLessons(
  context: unknown,
): SemanticLessonInjected[] {
  if (!Array.isArray(context)) return [];
  return context.filter(
    (item): item is SemanticLessonInjected =>
      item !== null &&
      typeof item === "object" &&
      (item as { type?: string }).type === "semantic_lesson" &&
      typeof (item as { text?: string }).text === "string",
  );
}

/** True when any injected lesson advises resolving customer_id before list_orders. */
export function lessonAdvisesResolveCustomerId(
  lessons: SemanticLessonInjected[],
): boolean {
  return lessons.some((l) => {
    const text = (l.text || "").toLowerCase();
    const factors = (l.factors || []).map((f) => f.toLowerCase());
    if (
      factors.includes("needs_customer_id") ||
      factors.includes("missing_customer_id") ||
      factors.includes("list_orders_before_resolve") ||
      factors.includes("customer_search")
    ) {
      return true;
    }
    return (
      text.includes("customer_id") &&
      (text.includes("before") ||
        text.includes("resolve") ||
        text.includes("search_customers"))
    );
  });
}

/** Format lessons for the TensorMux planner system prompt. */
export function formatLessonsForPrompt(
  lessons: SemanticLessonInjected[],
): string {
  if (lessons.length === 0) return "";
  const lines = lessons.map(
    (l, i) =>
      `${i + 1}. [${l.lesson_id}] (confidence=${l.confidence}, evidence=${l.evidence_count}, path=${l.retrieval_path}): ${l.text}`,
  );
  return [
    "Usable lessons from prior runs (follow these when applicable):",
    ...lines,
  ].join("\n");
}
