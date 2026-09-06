/**
 * List semantic lessons (Neo4j when configured, else local fallback store).
 *
 * Usage:
 *   npm run memory:lessons
 *   npm run neo4j:lessons
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import {
  closeSemanticMemory,
  listLessons,
  semanticFallbackPath,
} from "./semanticMemory.js";

config({ path: resolve(process.cwd(), ".env") });

async function main(): Promise<void> {
  const lessons = await listLessons();
  console.log(
    JSON.stringify(
      {
        type: "lessons_list",
        count: lessons.length,
        usable_count: lessons.filter((l) => l.usable).length,
        fallback_path: semanticFallbackPath(),
        neo4j_configured: Boolean(
          (process.env.NEO4J_URI || "").trim() &&
            (process.env.NEO4J_USER || "").trim() &&
            (process.env.NEO4J_PASSWORD || "").trim(),
        ),
        lessons: lessons.map((l) => ({
          id: l.id,
          tool: l.tool,
          usable: l.usable,
          evidence_count: l.evidence_count,
          confidence: l.confidence,
          factors: l.factors,
          condition: l.condition,
          text: l.text,
          supporting_run_ids: l.supporting_run_ids,
          backend: l.backend,
          created_at: l.created_at,
        })),
      },
      null,
      2,
    ),
  );
  await closeSemanticMemory();
}

main().catch(async (err) => {
  console.error(err);
  await closeSemanticMemory();
  process.exit(1);
});
