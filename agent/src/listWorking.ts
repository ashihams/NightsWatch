/**
 * Inspect recent working_runs rows (SQLite working memory).
 *
 * Usage: npm run working:list
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import {
  listWorkingRuns,
  workingMemoryDbPath,
} from "./workingMemory.js";

config({ path: resolve(process.cwd(), ".env") });

function main(): void {
  const limit = Number(process.argv[2]) || 20;
  const rows = listWorkingRuns(limit);

  console.log(`working db: ${workingMemoryDbPath()}`);
  console.log(`recent runs: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log("(empty — run npm run agent first)");
    return;
  }

  for (const row of rows) {
    console.log(
      JSON.stringify(
        {
          run_id: row.run_id,
          status: row.status,
          started_at: row.started_at,
          current_step: row.current_step,
          task_description: row.task_description,
          tool_call_log: row.tool_call_log,
          injected_context: row.injected_context,
        },
        null,
        2,
      ),
    );
    console.log("---");
  }
}

main();
