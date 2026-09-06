/**
 * Reflection step (Step 7): when the analyzer flags a run, propose a candidate lesson.
 *
 * LLM path: TensorMux (same gateway as planner), traced via Neatlogs wrapOpenAI.
 * Offline path: deterministic structured lesson from analyzer triggers / tool evidence.
 */

import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { AnalyzeRunResult, NormalizedToolCall } from "./analyzer.js";
import { maybeWrapOpenAI, withSpan } from "./observability.js";
import { tensormuxConfigured } from "./llm.js";
import { TOOL_DEFINITIONS } from "./tools.js";

export type CandidateLesson = {
  tool: string;
  condition: string;
  factors: string[];
  lesson_text: string;
  supporting_run_ids: string[];
  /** Stable id for Situation / Lesson merge across corroborating runs */
  situation_id: string;
  lesson_id: string;
  mode: "tensormux" | "offline";
};

function toolDescription(name: string): string {
  const def = TOOL_DEFINITIONS.find((t) => t.function.name === name);
  return def?.function.description || name;
}

export function situationIdFor(tool: string, factors: string[]): string {
  const key = `${tool}|${[...factors].map((f) => f.trim().toLowerCase()).filter(Boolean).sort().join(",")}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

export function lessonIdFor(situationId: string): string {
  return `lesson_${situationId}`;
}

function extractMissingCustomerIdSignals(
  toolCalls: NormalizedToolCall[],
  evidence: Record<string, unknown>,
): boolean {
  const fromCalls = toolCalls.some((c) => {
    if (c.name !== "list_orders") return false;
    if (!c.args?.customer_id) return true;
    const body = c.body;
    if (body && typeof body === "object") {
      const b = body as { error?: string; unscoped?: boolean };
      if (b.error === "missing_customer_id" || b.unscoped === true) return true;
    }
    return false;
  });
  if (fromCalls) return true;

  const failures = evidence.tool_failure;
  if (!Array.isArray(failures)) return false;
  return failures.some((f) => {
    if (!f || typeof f !== "object") return false;
    const row = f as { name?: string; error?: string; args?: Record<string, unknown> };
    if (row.name !== "list_orders") return false;
    if (row.error === "missing_customer_id") return true;
    if (!row.args?.customer_id) return true;
    return false;
  });
}

/**
 * Deterministic offline reflection — still emits a structured candidate lesson.
 */
export function offlineReflect(params: {
  runId: string;
  task: string;
  analysis: AnalyzeRunResult;
  toolCalls: NormalizedToolCall[];
}): CandidateLesson {
  const { runId, task, analysis, toolCalls } = params;
  const triggers = analysis.triggers;

  if (extractMissingCustomerIdSignals(toolCalls, analysis.evidence)) {
    const factors = [
      "missing_customer_id",
      "list_orders_before_resolve",
      "bad_list_orders_usage",
    ];
    const tool = "list_orders";
    const situation_id = situationIdFor(tool, factors);
    return {
      tool,
      condition:
        "list_orders called without a resolved customer_id (missing_customer_id / unscoped)",
      factors,
      lesson_text:
        "Before calling list_orders, resolve customer_id with search_customers (or get_customer). Never pass a display name as the order filter when the API requires customer_id.",
      supporting_run_ids: [runId],
      situation_id,
      lesson_id: lessonIdFor(situation_id),
      mode: "offline",
    };
  }

  const failed =
    toolCalls.find((c) => !c.ok) ||
    (Array.isArray(analysis.evidence.tool_failure) &&
    analysis.evidence.tool_failure[0] &&
    typeof analysis.evidence.tool_failure[0] === "object"
      ? {
          name: String(
            (analysis.evidence.tool_failure[0] as { name?: string }).name ||
              "unknown_tool",
          ),
        }
      : null);

  const tool = failed && "name" in failed ? String(failed.name) : "unknown_tool";
  const factors = [
    ...triggers.map((t) => `trigger:${t}`),
    ...(tool !== "unknown_tool" ? [`tool:${tool}`] : []),
  ];
  const uniqueFactors = [...new Set(factors)];
  const situation_id = situationIdFor(tool, uniqueFactors);

  return {
    tool,
    condition: `Analyzer flagged run for: ${triggers.join(", ") || "unknown"}`,
    factors: uniqueFactors,
    lesson_text: `When using ${tool} on tasks like "${task.slice(0, 80)}", avoid the failure pattern that triggered: ${triggers.join(", ")}. Inspect tool inputs and retry with corrected arguments.`,
    supporting_run_ids: [runId],
    situation_id,
    lesson_id: lessonIdFor(situation_id),
    mode: "offline",
  };
}

function parseLessonJson(raw: string): Partial<CandidateLesson> | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(body) as Partial<CandidateLesson>;
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1)) as Partial<CandidateLesson>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function tensormuxReflect(params: {
  runId: string;
  task: string;
  analysis: AnalyzeRunResult;
  toolCalls: NormalizedToolCall[];
}): Promise<CandidateLesson> {
  const rawClient = new OpenAI({
    apiKey: process.env.TENSORMUX_API_KEY!,
    baseURL: process.env.TENSORMUX_BASE_URL!,
  });
  const client = maybeWrapOpenAI(rawClient);
  const model = process.env.TENSORMUX_MODEL || "gpt-4o-mini";

  const toolSummary = params.toolCalls.map((c) => ({
    name: c.name,
    args: c.args,
    status: c.status,
    ok: c.ok,
    error:
      c.error ||
      (c.body && typeof c.body === "object"
        ? (c.body as { error?: string }).error
        : undefined),
  }));

  const system = `You are a reflection module for a support-ops agent that learns tool usage.
Given a flagged run (analyzer triggers + tool trace), propose ONE reusable lesson.
Respond with ONLY JSON:
{
  "tool": "<primary tool the lesson applies to>",
  "condition": "<short condition / when this applies>",
  "factors": ["factor_snake_case", "..."],
  "lesson_text": "<imperative guidance the planner can follow later>",
  "supporting_run_ids": ["<run ids>"]
}
Factors should be stable snake_case tags (e.g. missing_customer_id, retry_after_failure).
Prefer concrete tool-input fixes over vague advice.`;

  const user = JSON.stringify(
    {
      run_id: params.runId,
      task: params.task,
      triggers: params.analysis.triggers,
      evidence: params.analysis.evidence,
      tool_calls: toolSummary,
      known_tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.function.name,
        description: t.function.description,
      })),
    },
    null,
    2,
  );

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
  });

  const content = completion.choices[0]?.message?.content || "";
  const parsed = parseLessonJson(content);
  if (!parsed || !parsed.lesson_text || !parsed.tool) {
    // Fall back to deterministic if LLM output is unusable
    const offline = offlineReflect(params);
    return { ...offline, mode: "tensormux" };
  }

  const factors = Array.isArray(parsed.factors)
    ? parsed.factors.map(String).filter(Boolean)
    : ["unspecified_factor"];
  const tool = String(parsed.tool);
  const situation_id = situationIdFor(tool, factors);
  const supporting = Array.isArray(parsed.supporting_run_ids)
    ? parsed.supporting_run_ids.map(String)
    : [];
  if (!supporting.includes(params.runId)) supporting.push(params.runId);

  return {
    tool,
    condition: String(parsed.condition || `flagged: ${params.analysis.triggers.join(",")}`),
    factors,
    lesson_text: String(parsed.lesson_text),
    supporting_run_ids: supporting,
    situation_id,
    lesson_id: lessonIdFor(situation_id),
    mode: "tensormux",
  };
}

/**
 * Produce a structured candidate lesson for a flagged run.
 */
export async function reflectOnFlaggedRun(params: {
  runId: string;
  task: string;
  analysis: AnalyzeRunResult;
  toolCalls: NormalizedToolCall[];
}): Promise<CandidateLesson> {
  if (!params.analysis.flagged) {
    throw new Error("reflectOnFlaggedRun requires analysis.flagged=true");
  }

  return withSpan({ kind: "CHAIN", name: "reflectOnFlaggedRun" }, async () => {
    if (tensormuxConfigured()) {
      try {
        return await tensormuxReflect(params);
      } catch (err) {
        console.warn(
          "[reflection] TensorMux reflection failed — using offline fallback:",
          err instanceof Error ? err.message : err,
        );
        return offlineReflect(params);
      }
    }
    return offlineReflect(params);
  });
}

export { toolDescription };
