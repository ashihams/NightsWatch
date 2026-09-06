/**
 * Prove the deterministic analyzer on:
 * 1) a mocked naive (list_orders miss + retry) log → flagged=true
 * 2) a mocked clean log → flagged=false
 *
 * Usage: npm run analyzer:prove
 * Optional live offline run: npm run agent (with tools up) then check stdout.
 */

import { analyzeRun, type AnalyzeRunInput } from "./analyzer.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main(): void {
  const naiveInput: AnalyzeRunInput = {
    runId: "prove-naive",
    task: "Find orders for Jordan Lee",
    source: "working_memory",
    success: true,
    latencyMs: 120,
    priorEpisodes: [],
    toolCalls: [
      {
        name: "list_orders",
        args: { query: "Jordan Lee" },
        status: 400,
        ok: false,
        latencyMs: 12,
        body: { ok: false, error: "missing_customer_id" },
      },
      {
        name: "search_customers",
        args: { query: "Jordan Lee" },
        status: 200,
        ok: true,
        latencyMs: 15,
        body: { results: [{ customer_id: "c1" }] },
      },
      // retry of list_orders after prior failure
      {
        name: "list_orders",
        args: { customer_id: "c1" },
        status: 200,
        ok: true,
        latencyMs: 18,
        body: { orders: [] },
      },
      // redundant duplicate of search with same inputs
      {
        name: "search_customers",
        args: { query: "Jordan Lee" },
        status: 200,
        ok: true,
        latencyMs: 14,
        body: { results: [{ customer_id: "c1" }] },
      },
    ],
  };

  const naive = analyzeRun(naiveInput);
  console.log(
    JSON.stringify(
      {
        case: "naive_list_orders_miss",
        flagged: naive.flagged,
        triggers: naive.triggers,
      },
      null,
      2,
    ),
  );

  assert(naive.flagged === true, "naive run should be flagged");
  assert(
    naive.triggers.includes("tool_failure"),
    "expected tool_failure trigger",
  );
  assert(naive.triggers.includes("retry"), "expected retry trigger");
  assert(
    naive.triggers.includes("duplicate_tool_call"),
    "expected duplicate_tool_call trigger",
  );

  const cleanInput: AnalyzeRunInput = {
    runId: "prove-clean",
    task: "Find orders for Jordan Lee",
    source: "working_memory",
    success: true,
    latencyMs: 80,
    // Prior history already knows this successful sequence → no novel trigger
    priorEpisodes: [
      {
        run_id: "prior-1",
        tool_sequence: ["search_customers", "list_orders"],
        latency_ms: 75,
        success: true,
        situation_summary:
          "Task: Find orders for Jordan Lee. Tools: search_customers → list_orders. Outcome: success.",
      },
    ],
    toolCalls: [
      {
        name: "search_customers",
        args: { query: "Jordan Lee" },
        status: 200,
        ok: true,
        latencyMs: 20,
        body: { results: [{ customer_id: "c1" }] },
      },
      {
        name: "list_orders",
        args: { customer_id: "c1" },
        status: 200,
        ok: true,
        latencyMs: 22,
        body: { orders: [{ order_id: "o1" }] },
      },
    ],
  };

  const clean = analyzeRun(cleanInput);
  console.log(
    JSON.stringify(
      {
        case: "clean_run",
        flagged: clean.flagged,
        triggers: clean.triggers,
      },
      null,
      2,
    ),
  );

  assert(clean.flagged === false, "clean run should not be flagged");
  assert(clean.triggers.length === 0, "clean run should have zero triggers");

  console.log("\nanalyzer:prove OK — naive flagged, clean not flagged");
}

main();
