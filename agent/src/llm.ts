/**
 * All LLM calls go through TensorMux (OpenAI-compatible).
 * When credentials are missing, callers should use the offline planner.
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { maybeWrapOpenAI } from "./observability.js";
import { TOOL_DEFINITIONS } from "./tools.js";

export type LlmMessage = ChatCompletionMessageParam;

export type PlannerAction =
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "finish"; message: string };

export function tensormuxConfigured(): boolean {
  const base = (process.env.TENSORMUX_BASE_URL || "").trim();
  const key = (process.env.TENSORMUX_API_KEY || "").trim();
  return Boolean(base && key);
}

function client(): OpenAI {
  const raw = new OpenAI({
    apiKey: process.env.TENSORMUX_API_KEY!,
    baseURL: process.env.TENSORMUX_BASE_URL!,
  });
  // wrapOpenAI emits LLM spans when Neatlogs is initialized
  return maybeWrapOpenAI(raw);
}

const SYSTEM = `You are a support ops agent with CRM tools.
Complete the user's task by calling tools as needed, then finish with a short summary.
Be direct. Prefer calling tools over asking clarifying questions.
When you are done (success or stuck), respond with plain text only — no more tool calls.`;

/**
 * One planner step via TensorMux chat completions + tools.
 */
export async function planNextStep(
  task: string,
  history: LlmMessage[],
): Promise<PlannerAction> {
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
    ...history,
  ];

  const model = process.env.TENSORMUX_MODEL || "gpt-4o-mini";
  const completion = await client().chat.completions.create({
    model,
    messages,
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
  });

  const msg = completion.choices[0]?.message;
  if (!msg) {
    return { type: "finish", message: "Empty LLM response; stopping." };
  }

  const toolCalls = msg.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    const call = toolCalls[0];
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }
    return { type: "tool", name: call.function.name, args };
  }

  return {
    type: "finish",
    message: (msg.content || "").trim() || "Done.",
  };
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
