import { config } from "dotenv";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

config({ path: resolve(process.cwd(), ".env") });

const key = process.env.NEATLOGS_API_KEY!;
const url =
  process.env.NEATLOGS_MCP_URL ||
  `${(process.env.NEATLOGS_ENDPOINT || "https://ingest.neatlogs.com").replace(/\/+$/, "")}/mcp`;

async function call(
  sid: string | null,
  method: string,
  params: Record<string, unknown> | undefined,
  id = 1,
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
  let body: any;
  try {
    if (text.includes("data:")) {
      const last = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .pop()!;
      body = JSON.parse(last.slice(5));
    } else body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 800) };
  }
  return { ns, status: res.status, body };
}

async function main() {
  const init = await call(null, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "1" },
  });
  console.log("init", init.status, init.body.error || "ok");
  const sid = init.ns;
  await call(sid, "notifications/initialized", {}, 2);

  const list = await call(sid, "tools/list", {}, 3);
  const names = list.body.result?.tools?.map((t: { name: string }) => t.name);
  console.log("tools", names);

  const root = randomUUID();
  const child = randomUUID();
  const lt = await call(
    sid,
    "tools/call",
    {
      name: "log_trace",
      arguments: {
        workflow_name: "support-agent-planner",
        name: "probe-run",
        spans: [
          {
            span_id: root,
            name: "runOnePlanner",
            span_type: "WORKFLOW",
            status: "success",
            input: { run_id: "probe" },
            latency_ms: 10,
            start_time: new Date().toISOString(),
          },
          {
            span_id: child,
            parent_span_id: root,
            name: "tool.list_orders",
            span_type: "TOOL",
            status: "error",
            input: { query: "x" },
            output: { status: 404 },
            latency_ms: 5,
            start_time: new Date().toISOString(),
            metadata: { tool_name: "list_orders" },
          },
        ],
        metadata: { framework: "nights-watch", agent_name: "probe" },
      },
    },
    4,
  );
  console.log("log_trace", JSON.stringify(lt.body).slice(0, 1200));

  const search = await call(
    sid,
    "tools/call",
    {
      name: "search_traces",
      arguments: {
        query: "support-agent-planner",
        limit: 3,
        filters: { date_range: "last_24h" },
      },
    },
    5,
  );
  console.log("search", JSON.stringify(search.body).slice(0, 1500));

  let searchPayload: any = search.body.result;
  if (searchPayload?.content?.[0]?.text) {
    try {
      searchPayload = JSON.parse(searchPayload.content[0].text);
    } catch {
      /* keep */
    }
  }
  const results = searchPayload?.results || searchPayload?.traces || [];
  const tid = results[0]?.trace_id || results[0]?.id || results[0]?.traceId;
  console.log("picked", tid);
  if (tid) {
    const ctx = await call(
      sid,
      "tools/call",
      { name: "get_trace_context", arguments: { trace_id: tid } },
      6,
    );
    console.log("context", JSON.stringify(ctx.body).slice(0, 2000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
