/**
 * CLI: run one sample planner task against the mock CRM tools.
 *
 * Prerequisites: mock server must be up (`npm run tools` in another terminal).
 *
 * Usage:
 *   npm run agent
 *   npm run agent -- "Find orders for Jordan Lee and open a support ticket about late shipment"
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { initObservability, shutdownObservability } from "./observability.js";
import { runOnePlanner } from "./runPlanner.js";

config({ path: resolve(process.cwd(), ".env") });

const DEFAULT_TASK =
  "Find orders for Jordan Lee and open a support ticket about late shipment";

async function main(): Promise<void> {
  // Neatlogs must init before planner / LLM / tool loops
  await initObservability();

  try {
    const task = process.argv.slice(2).join(" ").trim() || DEFAULT_TASK;
    const result = await runOnePlanner(task);

    console.log("\n--- summary ---");
    console.log(`run_id: ${result.runId}`);
    console.log(`mode: ${result.mode}`);
    console.log(`tool calls: ${result.steps}`);
    for (const c of result.toolCalls) {
      console.log(
        `  - ${c.name} status=${c.status} ok=${c.ok} ${c.latencyMs}ms args=${JSON.stringify(c.args)}`,
      );
    }
    console.log(`final: ${result.finalMessage}`);

    if (result.analysis) {
      console.log(
        `\nanalyzer: flagged=${result.analysis.flagged} source=${result.analysisSource ?? "?"} triggers=${JSON.stringify(result.analysis.triggers)}`,
      );
    }

    const provedListOrdersMiss = result.toolCalls.some(
      (c) =>
        c.name === "list_orders" &&
        (!c.args.customer_id ||
          c.status === 400 ||
          (c.body &&
            typeof c.body === "object" &&
            ((c.body as { error?: string }).error === "missing_customer_id" ||
              (c.body as { unscoped?: boolean }).unscoped === true))),
    );

    if (provedListOrdersMiss) {
      console.log(
        "\n[expected] Naive path hit list_orders without a resolved customer_id — failure/unscoped response is intentional for later learning.",
      );
    }
  } finally {
    await shutdownObservability();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
