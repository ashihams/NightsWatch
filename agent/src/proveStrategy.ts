/**
 * Prove Step 8 strategy injection (needs mock tools on :5678).
 *
 * 1. Two offline naive runs → promote usable lesson (evidence_count>=2)
 * 2. Baseline snapshot: failed/redundant list_orders from a naive run (injection off)
 * 3. Unseen/variant task wording with injection on → fewer list_orders misses
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { initObservability, shutdownObservability } from "./observability.js";
import { runOnePlanner, type PlannerRunResult } from "./runPlanner.js";
import {
  clearSemanticStore,
  closeSemanticMemory,
  listUsableLessons,
} from "./semanticMemory.js";
import type { ToolCallResult } from "./tools.js";

config({ path: resolve(process.cwd(), ".env") });

/** Deterministic prove path: offline planner + working-memory analyzer. */
function forceOfflineProveMode(): void {
  process.env.TENSORMUX_BASE_URL = "";
  process.env.TENSORMUX_API_KEY = "";
  process.env.NEATLOGS_API_KEY = "";
}

type ListOrdersStats = {
  total: number;
  failed_or_unscoped: number;
  with_customer_id: number;
  first_tool: string | null;
  sequence: string[];
};

function listOrdersStats(toolCalls: ToolCallResult[]): ListOrdersStats {
  const listCalls = toolCalls.filter((c) => c.name === "list_orders");
  let failed_or_unscoped = 0;
  let with_customer_id = 0;
  for (const c of listCalls) {
    const hasId = Boolean(c.args?.customer_id);
    if (hasId) with_customer_id += 1;
    const miss =
      !hasId ||
      !c.ok ||
      (c.body &&
        typeof c.body === "object" &&
        ((c.body as { error?: string }).error === "missing_customer_id" ||
          (c.body as { unscoped?: boolean }).unscoped === true));
    if (miss) failed_or_unscoped += 1;
  }
  return {
    total: listCalls.length,
    failed_or_unscoped,
    with_customer_id,
    first_tool: toolCalls[0]?.name ?? null,
    sequence: toolCalls.map((c) => c.name),
  };
}

async function promoteUsableLesson(): Promise<void> {
  forceOfflineProveMode();
  await clearSemanticStore();

  // During promotion, disable injection so the teaching signal stays naive.
  process.env.STRATEGY_INJECTION = "0";

  const task1 =
    "Find orders for Jordan Lee and open a support ticket about late shipment";
  const task2 =
    "Find orders for Sam Rivera — customer reported missing_customer_id style list_orders miss";

  console.log("\n=== promote run 1 (candidate) ===");
  const r1 = await runOnePlanner(task1);
  if (!r1.reflection || r1.reflection.lesson.usable) {
    throw new Error("promote run 1 expected candidate (usable=false)");
  }

  console.log("\n=== promote run 2 (usable) ===");
  const r2 = await runOnePlanner(task2);
  if (!r2.reflection || !r2.reflection.lesson.usable) {
    throw new Error("promote run 2 expected usable lesson");
  }

  const usable = await listUsableLessons();
  if (usable.length < 1) {
    throw new Error("expected at least one usable lesson after promotion");
  }

  console.log(
    JSON.stringify({
      type: "prove_strategy_promoted",
      lesson_id: r2.reflection.lesson.id,
      evidence_count: r2.reflection.lesson.evidence_count,
      text: r2.reflection.lesson.text,
      factors: r2.reflection.lesson.factors,
    }),
  );
}

async function main(): Promise<void> {
  forceOfflineProveMode();
  await initObservability();

  try {
    await promoteUsableLesson();

    // Naive baseline on an unseen wording with injection OFF
    process.env.STRATEGY_INJECTION = "0";
    const naiveTask =
      "Look up purchases belonging to Morgan Blake and file a support ticket for a delayed delivery";
    console.log("\n=== naive baseline (injection off, unseen wording) ===");
    const naive: PlannerRunResult = await runOnePlanner(naiveTask);
    const naiveStats = listOrdersStats(naive.toolCalls);
    console.log(
      JSON.stringify({
        type: "prove_strategy_naive",
        task: naiveTask,
        ...naiveStats,
      }),
    );

    // Same underlying need, different wording, injection ON
    process.env.STRATEGY_INJECTION = "1";
    const injectedTask =
      "Pull the order history for Taylor Kim then open a ticket about a late package";
    console.log("\n=== injected run (unseen wording, strategy on) ===");
    const injected: PlannerRunResult = await runOnePlanner(injectedTask);
    const injectedStats = listOrdersStats(injected.toolCalls);
    console.log(
      JSON.stringify({
        type: "prove_strategy_injected",
        task: injectedTask,
        ...injectedStats,
      }),
    );

    if (injectedStats.first_tool !== "search_customers") {
      throw new Error(
        `expected injected run to start with search_customers, got ${injectedStats.first_tool}`,
      );
    }
    if (injectedStats.failed_or_unscoped >= naiveStats.failed_or_unscoped) {
      throw new Error(
        `expected fewer failed/unscoped list_orders with injection: naive=${naiveStats.failed_or_unscoped} injected=${injectedStats.failed_or_unscoped}`,
      );
    }
    if (injectedStats.failed_or_unscoped !== 0) {
      throw new Error(
        `expected zero failed/unscoped list_orders after injection, got ${injectedStats.failed_or_unscoped}`,
      );
    }

    console.log("\n--- prove strategy summary ---");
    console.log(
      JSON.stringify(
        {
          type: "prove_strategy_ok",
          naive: {
            task: naiveTask,
            first_tool: naiveStats.first_tool,
            sequence: naiveStats.sequence,
            failed_or_unscoped_list_orders: naiveStats.failed_or_unscoped,
          },
          injected: {
            task: injectedTask,
            first_tool: injectedStats.first_tool,
            sequence: injectedStats.sequence,
            failed_or_unscoped_list_orders: injectedStats.failed_or_unscoped,
          },
          improvement: {
            failed_list_orders_delta:
              naiveStats.failed_or_unscoped - injectedStats.failed_or_unscoped,
            note: "injected unseen task resolves customer_id before list_orders",
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await closeSemanticMemory();
    await shutdownObservability();
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeSemanticMemory();
  await shutdownObservability();
  process.exit(1);
});
