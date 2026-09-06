/**
 * All LLM calls go through TensorMux (OpenAI-compatible).
 * When credentials are missing, callers should use the offline planner.
 *
 * Neatlogs wrapOpenAI records LLM spans; we also capture TensorMux response
 * headers (x-request-id, x-tensormux-backend) for gateway↔trace correlation.
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { maybeWrapOpenAI, withSpan } from "./observability.js";
import { TOOL_DEFINITIONS } from "./tools.js";

export type LlmMessage = ChatCompletionMessageParam;

export type PlannerAction =
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "finish"; message: string };

export type TensorMuxCallMeta = {
  model: string;
  request_id?: string;
  backend?: string;
};

let lastTensorMuxMeta: TensorMuxCallMeta | null = null;

export function getLastTensorMuxMeta(): TensorMuxCallMeta | null {
  return lastTensorMuxMeta;
}

export function tensormuxConfigured(): boolean {
  const base = (process.env.TENSORMUX_BASE_URL || "").trim();
  const key = (process.env.TENSORMUX_API_KEY || "").trim();
  return Boolean(base && key);
}

function client(): OpenAI {
  const raw = new OpenAI({
    apiKey: process.env.TENSORMUX_API_KEY!,
    baseURL: process.env.TENSORMUX_BASE_URL!,
    defaultHeaders: {
      "X-loop-Client": "support-agent-planner",
    },
  });
  return maybeWrapOpenAI(raw);
}

const SYSTEM = `You are a support ops agent with CRM tools.
Complete the user's task by calling tools as needed, then finish with a short summary.
Be direct. Prefer calling tools over asking clarifying questions.
When you are done (success or stuck), respond with plain text only — no more tool calls.`;

/**
 * One planner step via TensorMux chat completions + tools.
 * Optional `lessonBlock` is appended to the system prompt (Step 8 strategy injection).
 */
export async function planNextStep(
  task: string,
  history: LlmMessage[],
  lessonBlock?: string,
): Promise<PlannerAction> {
  // Pass task into the span so Neatlogs AGENT input is non-empty.
  return withSpan(
    { kind: "AGENT", name: "planNextStep" },
    async (agentInput) => {
    const systemContent = lessonBlock?.trim()
      ? `${SYSTEM}\n\n${lessonBlock.trim()}`
      : SYSTEM;
    const messages: LlmMessage[] = [
      { role: "system", content: systemContent },
      { role: "user", content: agentInput.task },
      ...agentInput.history,
    ];

    const model = process.env.TENSORMUX_MODEL || "gpt-4o-mini";

    // Note: neatlogs wrapOpenAI returns a plain Promise (not OpenAI APIPromise),
    // so .withResponse() is unavailable — correlate via TensorMux /tensormux/requests.
    const data = await client().chat.completions.create({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    });

    lastTensorMuxMeta = { model };
    try {
      const origin = new URL(
        (process.env.TENSORMUX_BASE_URL || "").replace(/\/v1\/?$/, ""),
      ).origin;
      const res = await fetch(`${origin}/tensormux/requests`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const json = (await res.json()) as unknown;
        const list = Array.isArray(json)
          ? json
          : Array.isArray((json as { requests?: unknown }).requests)
            ? (json as { requests: unknown[] }).requests
            : [];
        const last = list[list.length - 1] as
          | Record<string, unknown>
          | undefined;
        if (last) {
          lastTensorMuxMeta = {
            model,
            request_id: String(last.request_id || last.id || "") || undefined,
            backend: String(last.backend || "") || undefined,
          };
        }
      }
    } catch {
      // optional enrichment
    }
    console.log(
      JSON.stringify({ type: "tensormux_llm_call", ...lastTensorMuxMeta }),
    );

    const msg = data.choices[0]?.message;
    if (!msg) {
      return { type: "finish", message: "Empty LLM response; stopping." };
    }

    const toolCalls = msg.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const call = toolCalls[0];
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        args = {};
      }
      return { type: "tool", name: call.function.name, args };
    }

    return {
      type: "finish",
      message: (msg.content || "").trim() || "Done.",
    };
  },
    { task, history },
  );
}

export function assistantToolStub(
  name: string,
  args: Record<string, unknown>,
  callId = "call_1",
): LlmMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: callId,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

export function toolResultMessage(callId: string, result: unknown): LlmMessage {
  return {
    role: "tool",
    tool_call_id: callId,
    content: JSON.stringify(result),
  };
}
