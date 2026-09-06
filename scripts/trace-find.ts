import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

config({ path: resolve(process.cwd(), ".env") });

const key = (process.env.NEATLOGS_API_KEY || "").trim();
if (!key) {
  console.error("missing NEATLOGS_API_KEY");
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
    body = { raw: text.slice(0, 500) };
  }
  return { ns, status: res.status, body };
}

function unwrap(body: any): any {
  if (body?.result?.isError) {
    throw new Error(body.result.content?.[0]?.text || "tool error");
  }
  const text = body?.result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return body?.result;
}

async function main() {
  const runId = process.argv[2] || "df9be496-0c80-42a2-b421-6e8052423a5d";
  const init = await call(
    null,
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "trace-find", version: "1" },
    },
    1,
  );
  const sid = init.ns!;
  await call(sid, "notifications/initialized", {}, 2);

  const who = unwrap(
    (await call(sid, "tools/call", { name: "whoami", arguments: {} }, 3)).body,
  );

  const queries = [
    runId,
    `loop.run_id ${runId}`,
    `nights_watch.run_id ${runId}`,
    "loop_eval",
    "support-agent-planner",
    "runOnePlanner",
    "12345",
  ];

  const searches: Record<string, unknown> = {};
  let id = 10;
  for (const q of queries) {
    id += 1;
    const payload = unwrap(
      (
        await call(
          sid,
          "tools/call",
          { name: "search_traces", arguments: { query: q, limit: 10 } },
          id,
        )
      ).body,
    );
    const results = (payload?.results || payload?.traces || []) as any[];
    searches[q] = {
      total: payload?.total ?? results.length,
      hits: results.slice(0, 8).map((r) => ({
        trace_id: r.trace_id || r.id,
        name: r.workflow_name || r.name || r.root_span_name,
        when: r.created_at || r.ingested_at || r.start_time || r.timestamp,
        snippet: JSON.stringify(r).slice(0, 200),
      })),
    };
  }

  const out = { who, runId, searches, checked_at: new Date().toISOString() };
  writeFileSync(
    resolve(process.cwd(), "scripts/trace-find-out.json"),
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
