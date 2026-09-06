/**
 * Inspect recent episodic memory rows (SQLite vector store).
 *
 * Usage: npm run episodic:list
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import {
  episodicMemoryDbPath,
  listEpisodes,
} from "./episodicMemory.js";

config({ path: resolve(process.cwd(), ".env") });

function main(): void {
  const limit = Number(process.argv[2]) || 20;
  const rows = listEpisodes(limit);

  console.log(`episodic db: ${episodicMemoryDbPath()}`);
  console.log(`recent episodes: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log("(empty — run npm run agent first)");
    return;
  }

  for (const row of rows) {
    console.log(
      JSON.stringify(
        {
          id: row.id,
          run_id: row.run_id,
          created_at: row.created_at,
          success: row.success,
          tool_call_count: row.tool_call_count,
          token_count: row.token_count,
          latency_ms: row.latency_ms,
          embed_backend: row.embed_backend,
          embed_model: row.embed_model,
          embedding_dim: row.embedding.length,
          tool_sequence: row.tool_sequence,
          situation_summary: row.situation_summary,
        },
        null,
        2,
      ),
    );
    console.log("---");
  }
}

main();
