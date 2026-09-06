/**
 * Prove Step 7 evidence gate with two offline naive runs (needs mock tools on :5678).
 *
 * Run 1 → candidate lesson (evidence_count=1, not usable)
 * Run 2 → promoted (evidence_count>=2, usable)
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { initObservability, shutdownObservability } from "./observability.js";
import { runOnePlanner } from "./runPlanner.js";
import {
  clearLocalSemanticStore,
  closeSemanticMemory,
  listLessons,
  semanticFallbackPath,
} from "./semanticMemory.js";

config({ path: resolve(process.cwd(), ".env") });

async function main(): Promise<void> {
  // Force a clean local prove (even if Neo4j is configured, clear local; Neo4j
  // lessons still accumulate by situation id — local fallback is the offline demo path).
  if (
    !(process.env.NEO4J_URI || "").trim() ||
    !(process.env.NEO4J_USER || "").trim() ||
    !(process.env.NEO4J_PASSWORD || "").trim()
  ) {
    clearLocalSemanticStore();
    console.log(
      JSON.stringify({
        type: "prove_reflection_reset",
        store: semanticFallbackPath(),
      }),
    );
  }

  await initObservability();

  try {
    const task1 =
      "Find orders for Jordan Lee and open a support ticket about late shipment";
    const task2 =
      "Find orders for Sam Rivera — customer reported missing_customer_id style list_orders miss";

    console.log("\n=== run 1 (expect candidate) ===");
    const r1 = await runOnePlanner(task1);
    if (!r1.analysis?.flagged) {
      throw new Error("run 1 expected analyzer flagged=true");
    }
    if (!r1.reflection) {
      throw new Error("run 1 expected reflection store result");
    }
    if (r1.reflection.lesson.evidence_count !== 1 || r1.reflection.lesson.usable) {
      throw new Error(
        `run 1 expected evidence_count=1 usable=false, got count=${r1.reflection.lesson.evidence_count} usable=${r1.reflection.lesson.usable}`,
      );
    }
    console.log(
      JSON.stringify({
        type: "prove_run1_ok",
        lesson_id: r1.reflection.lesson.id,
        evidence_count: r1.reflection.lesson.evidence_count,
        usable: r1.reflection.lesson.usable,
        backend: r1.reflection.backend,
      }),
    );

    console.log("\n=== run 2 (expect promoted) ===");
    const r2 = await runOnePlanner(task2);
    if (!r2.analysis?.flagged) {
      throw new Error("run 2 expected analyzer flagged=true");
    }
    if (!r2.reflection) {
      throw new Error("run 2 expected reflection store result");
    }
    if (
      r2.reflection.lesson.evidence_count < 2 ||
      !r2.reflection.lesson.usable
    ) {
      throw new Error(
        `run 2 expected evidence_count>=2 usable=true, got count=${r2.reflection.lesson.evidence_count} usable=${r2.reflection.lesson.usable}`,
      );
    }
    if (r2.reflection.lesson.id !== r1.reflection.lesson.id) {
      throw new Error(
        `expected same lesson_id across corroborating runs: ${r1.reflection.lesson.id} vs ${r2.reflection.lesson.id}`,
      );
    }
    console.log(
      JSON.stringify({
        type: "prove_run2_ok",
        lesson_id: r2.reflection.lesson.id,
        evidence_count: r2.reflection.lesson.evidence_count,
        usable: r2.reflection.lesson.usable,
        confidence: r2.reflection.lesson.confidence,
        promoted_this_run: r2.reflection.promoted,
        backend: r2.reflection.backend,
      }),
    );

    const lessons = await listLessons();
    const usable = lessons.filter((l) => l.usable);
    console.log("\n--- prove summary ---");
    console.log(
      JSON.stringify(
        {
          type: "prove_reflection_ok",
          lessons: lessons.length,
          usable: usable.length,
          lesson: {
            id: r2.reflection.lesson.id,
            evidence_count: r2.reflection.lesson.evidence_count,
            usable: r2.reflection.lesson.usable,
            text: r2.reflection.lesson.text,
            backend: r2.reflection.backend,
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
