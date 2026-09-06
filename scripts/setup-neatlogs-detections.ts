/**
 * Bootstrap Loop detections on Neatlogs (drift + failure + latency/token proxies).
 * Secrets stay in env — never printed.
 *
 *   npx tsx scripts/setup-neatlogs-detections.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

config({ path: resolve(process.cwd(), ".env") });

const key = (process.env.NEATLOGS_API_KEY || "").trim();
if (!key) {
  console.error("NEATLOGS_API_KEY missing in .env");
  process.exit(1);
}

const url =
  process.env.NEATLOGS_MCP_URL ||
  `${(process.env.NEATLOGS_ENDPOINT || "https://ingest.neatlogs.com").replace(/\/+$/, "")}/mcp`;

async function call(
  sid: string | null,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }),
  });
  const ns = res.headers.get("mcp-session-id") || sid;
  const text = await res.text();
  let body: unknown;
  try {
    if (text.includes("data:")) {
      const last = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .pop()!;
      body = JSON.parse(last.slice(5));
    } else body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { ns, status: res.status, body };
}

function unwrap(body: any): unknown {
  const result = body?.result;
  if (result?.isError) {
    throw new Error(result.content?.[0]?.text || "tool error");
  }
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

type DetectionPayload = {
  display_name: string;
  description: string;
  group_id: string;
  type: "regex" | "conditional" | "pii" | "classifier";
  config: Record<string, unknown>;
  threshold?: number;
  run_on?: Record<string, unknown>;
};

async function main() {
  const init = await call(
    null,
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "loop-det-setup", version: "1" },
    },
    1,
  );
  const sid = init.ns!;
  await call(sid, "notifications/initialized", {}, 2);

  const toolsRes = await call(sid, "tools/list", {}, 3);
  const tools = ((toolsRes.body as any)?.result?.tools || []).map((t: any) => ({
    name: t.name,
    required: t.inputSchema?.required,
    props: Object.keys(t.inputSchema?.properties || {}),
  }));
  writeFileSync(
    resolve(process.cwd(), "scripts/mcp-tools.json"),
    JSON.stringify(tools, null, 2),
  );
  console.log(
    "mcp tools:",
    tools.map((t: { name: string }) => t.name).join(", "),
  );

  const groups = unwrap(
    (await call(sid, "tools/call", { name: "list_detection_groups", arguments: {} }, 4))
      .body,
  ) as any;
  const byName = (n: string) =>
    groups?.groups?.find((g: any) => String(g.name).toLowerCase() === n)?.id;
  const negative = byName("negative");
  const neutral = byName("neutral");
  const positive = byName("positive");
  if (!negative || !neutral) {
    console.error("Expected Negative/Neutral groups");
    process.exit(1);
  }

  const existing = unwrap(
    (await call(sid, "tools/call", { name: "list_detections", arguments: { limit: 100 } }, 5))
      .body,
  ) as any;
  const existingNames = new Set(
    (existing?.detections || []).map((d: any) =>
      String(d.display_name || "").toLowerCase(),
    ),
  );

  // Loop analyzer ↔ Neatlogs detections (drift + robustness + latency/token proxies)
  const payloads: DetectionPayload[] = [
    {
      display_name: "Loop: missing_customer_id drift",
      description:
        "Teaching/drift signal: tool output reports missing_customer_id (list_orders before resolve).",
      group_id: negative,
      type: "regex",
      config: {
        output_pattern: "missing_customer_id",
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    {
      display_name: "Loop: unscoped tool call",
      description: "Flags unscoped:true in tool output (bad list_orders usage).",
      group_id: negative,
      type: "regex",
      config: {
        output_pattern: '"unscoped"\\s*:\\s*true',
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    {
      display_name: "Loop: tool ok:false",
      description: "Robustness: any tool/agent payload with ok:false.",
      group_id: negative,
      type: "regex",
      config: {
        output_pattern: '"ok"\\s*:\\s*false',
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    {
      display_name: "Loop: retry / duplicate tool pattern",
      description:
        "Drift: repeated list_orders or search_customers in one run (retry / duplicate_tool_call).",
      group_id: negative,
      type: "regex",
      config: {
        output_pattern: "(list_orders.*){2,}|(search_customers.*){2,}",
        input_pattern: "(list_orders.*){2,}|(search_customers.*){2,}",
        operator: "OR",
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    {
      display_name: "Loop: novel tool sequence cue",
      description:
        "Heuristic drift cue when analyzer notes novel_tool_sequence in output metadata.",
      group_id: neutral,
      type: "regex",
      config: {
        output_pattern: "novel_tool_sequence|analyzer_triggers",
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    // Conditional LLM field detections currently 500 from Neatlogs ("AI service error").
    // Eval metrics are stamped on WORKFLOW output — match those instead:
    {
      display_name: "Loop: latency_flag",
      description: "Eval metric: WORKFLOW output latency_flag true (budget exceeded).",
      group_id: neutral,
      type: "regex",
      config: {
        output_pattern: '"latency_flag"\\s*:\\s*true',
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    {
      display_name: "Loop: robustness_flag",
      description: "Eval metric: robustness_flag true (tool failures / unscoped).",
      group_id: negative,
      type: "regex",
      config: {
        output_pattern: '"robustness_flag"\\s*:\\s*true',
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    {
      display_name: "Loop: low speed_score",
      description: "Eval metric: speed_score below 0.4 (slow run).",
      group_id: neutral,
      type: "regex",
      config: {
        output_pattern: '"speed_score"\\s*:\\s*0\\.[0-3]\\d*',
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
    {
      display_name: "Loop: high token_total",
      description: "Eval metric: token_total reported above 4000.",
      group_id: neutral,
      type: "regex",
      config: {
        output_pattern: '"token_total"\\s*:\\s*([4-9]\\d{3}|\\d{5,})',
        case_sensitive: false,
      },
      threshold: 0.5,
      run_on: { frequency: "trace" },
    },
  ];

  // Keep Positive group referenced so unused var lint doesn't fire if we add later
  void positive;

  let id = 20;
  const results: Array<{ name: string; status: string; detail?: unknown }> = [];
  for (const p of payloads) {
    if (existingNames.has(p.display_name.toLowerCase())) {
      results.push({ name: p.display_name, status: "exists" });
      continue;
    }
    id += 1;
    try {
      const res = await call(
        sid,
        "tools/call",
        { name: "create_detection", arguments: p },
        id,
      );
      const out = unwrap(res.body) as any;
      if (out?.error) {
        results.push({ name: p.display_name, status: "error", detail: out.error });
      } else {
        results.push({
          name: p.display_name,
          status: "created",
          detail: out?.id || out?.slug || out,
        });
        existingNames.add(p.display_name.toLowerCase());
      }
    } catch (e) {
      results.push({
        name: p.display_name,
        status: "exception",
        detail: e instanceof Error ? e.message.slice(0, 500) : String(e),
      });
    }
  }

  const after = unwrap(
    (await call(sid, "tools/call", { name: "list_detections", arguments: { limit: 100 } }, 99))
      .body,
  ) as any;

  writeFileSync(
    resolve(process.cwd(), "scripts/setup-detections-results.json"),
    JSON.stringify({ results, total: after?.total, detections: after?.detections }, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  console.log(
    "total detections:",
    after?.total,
    (after?.detections || []).map((d: any) => d.display_name).join(" | "),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
