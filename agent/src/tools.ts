/**
 * Thin HTTP client for the five mock CRM webhooks.
 * Logs every call (name, args, status, latency) to stdout.
 */

import { withSpan } from "./observability.js";

export const TOOL_NAMES = [
  "search_customers",
  "get_customer",
  "list_orders",
  "get_order",
  "create_ticket",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolCallResult = {
  name: ToolName;
  args: Record<string, unknown>;
  status: number;
  ok: boolean;
  latencyMs: number;
  body: unknown;
};

function toolsBaseUrl(): string {
  return (process.env.TOOLS_BASE_URL || "http://localhost:5678").replace(/\/+$/, "");
}

export async function callTool(
  name: ToolName,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  return withSpan({ kind: "TOOL", name: `tool.${name}`, toolName: name }, async () => {
    const url = `${toolsBaseUrl()}/webhook/${name}`;
    const started = Date.now();
    let status = 0;
    let body: unknown = null;
    let ok = false;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      status = res.status;
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
      // Unscoped / teaching-miss responses are HTTP 200 but not usable — treat as not-ok
      // so working-memory logs and the analyzer see the intentional list_orders miss.
      const unscopedMiss =
        body &&
        typeof body === "object" &&
        ((body as { unscoped?: boolean }).unscoped === true ||
          (body as { error?: string }).error === "missing_customer_id");
      ok =
        res.ok &&
        !unscopedMiss &&
        !(body && typeof body === "object" && (body as { ok?: boolean }).ok === false);
    } catch (err) {
      status = 0;
      ok = false;
      body = {
        ok: false,
        error: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const latencyMs = Date.now() - started;
    const result: ToolCallResult = { name, args, status, ok, latencyMs, body };

    // Structured stdout log for demos / later AO session capture
    console.log(
      JSON.stringify({
        type: "tool_call",
        name: result.name,
        args: result.args,
        status: result.status,
        ok: result.ok,
        latency_ms: result.latencyMs,
      }),
    );

    return result;
  });
}

/** OpenAI-style function schemas (intentionally light — naive agent won't see deep deps). */
export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "search_customers",
      description: "Search for customers by name or email fragment.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search string, e.g. a person name" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_customer",
      description: "Fetch a customer profile.",
      parameters: {
        type: "object",
        properties: {
          customer_id: { type: "string" },
        },
        required: ["customer_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_orders",
      description: "List orders. Accepts optional filters in JSON.",
      parameters: {
        type: "object",
        properties: {
          customer_id: { type: "string", description: "Customer id if known" },
          query: { type: "string", description: "Name or free-text filter" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_order",
      description: "Get a single order by id.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string" },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_ticket",
      description: "Open a support ticket.",
      parameters: {
        type: "object",
        properties: {
          customer_id: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["subject", "body"],
      },
    },
  },
];
