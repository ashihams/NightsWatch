/**
 * Re-embed all episodic rows with the current embed backend (Ollama/API).
 * Skips rows that already match the live backend+model+dim.
 *
 *   npx tsx scripts/reembed-episodes.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embedText } from "../agent/src/embeddings.js";

config({ path: resolve(process.cwd(), ".env") });

async function main() {
  const path = resolve(
    process.cwd(),
    process.env.EPISODIC_DB_PATH || "./data/episodic.sqlite",
  );
  const db = new DatabaseSync(path);
  const rows = db
    .prepare(
      `SELECT id, situation_summary, embed_backend, embed_model, embedding
       FROM episodes ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    situation_summary: string;
    embed_backend: string;
    embed_model: string;
    embedding: string;
  }>;

  console.log(JSON.stringify({ type: "reembed_start", path, count: rows.length }));

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const live = await embedText(row.situation_summary);
    const prev = JSON.parse(row.embedding || "[]") as number[];
    if (
      row.embed_backend === live.backend &&
      row.embed_model === live.model &&
      prev.length === live.vector.length
    ) {
      skipped += 1;
      continue;
    }
    db.prepare(
      `UPDATE episodes
       SET embedding = ?, embed_backend = ?, embed_model = ?
       WHERE id = ?`,
    ).run(JSON.stringify(live.vector), live.backend, live.model, row.id);
    updated += 1;
    console.log(
      JSON.stringify({
        type: "reembed_row",
        id: row.id,
        from: `${row.embed_backend}/${row.embed_model}/${prev.length}`,
        to: `${live.backend}/${live.model}/${live.vector.length}`,
      }),
    );
  }

  console.log(
    JSON.stringify({ type: "reembed_done", updated, skipped, total: rows.length }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
