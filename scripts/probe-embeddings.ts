import "dotenv/config";
import { embedText, cosineSimilarity } from "../agent/src/embeddings.js";
import {
  retrieveEpisodes,
  writeEpisode,
  buildSituationSummary,
} from "../agent/src/episodicMemory.js";

async function main() {
  const a = await embedText("refund for order ORD-1001 customer C-42");
  const b = await embedText("customer C-42 wants refund on ORD-1001");
  const c = await embedText("weather in Tokyo tomorrow");
  console.log(
    JSON.stringify(
      {
        type: "embed_probe",
        backend: a.backend,
        model: a.model,
        dim: a.vector.length,
        similar: Number(cosineSimilarity(a.vector, b.vector).toFixed(4)),
        different: Number(cosineSimilarity(a.vector, c.vector).toFixed(4)),
      },
      null,
      2,
    ),
  );

  const summary = buildSituationSummary(
    "Refund ORD-1001 for customer C-42",
    ["lookup_order", "issue_refund"],
    true,
  );
  const written = await writeEpisode({
    run_id: `embed-probe-${Date.now()}`,
    situation_summary: summary,
    tool_sequence: ["lookup_order", "issue_refund"],
    success: true,
    tool_call_count: 2,
    token_count: 0,
    latency_ms: 1,
  });
  const hits = await retrieveEpisodes("customer wants a refund on order ORD-1001", 3);
  console.log(
    JSON.stringify(
      {
        type: "episodic_probe",
        wrote: {
          id: written.id,
          backend: written.embed_backend,
          model: written.embed_model,
          dim: written.embedding.length,
        },
        hit_count: hits.length,
        top: hits[0]
          ? {
              run_id: hits[0].run_id,
              similarity: hits[0].similarity,
              backend: hits[0].embed_backend,
            }
          : null,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
