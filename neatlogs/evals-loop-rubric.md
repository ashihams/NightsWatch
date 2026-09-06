# Loop × Neatlogs — Evals rubric

Neatlogs MCP has **no create_eval tool**. Create this evaluation once in the dashboard:

1. Open [Evals](https://app.neatlogs.com/evals) → **New evaluation**
2. Name: `Loop agent quality (speed / latency / robustness / tokens)`
3. Trace source: **new traces** for workflow `support-agent-planner` (or last 14 days)
4. Build the form with the questions below
5. Assign an **AI evaluator** (or yourself) to each question → Launch

Every Loop planner run now stamps `loop_eval` on the WORKFLOW output (`latency_ms`, `speed_score`, `robustness_score`, `token_*`, `drift_signals`). Use those fields when judging.

## Form questions

| # | Question | Type | Scale / options | What good looks like |
|---|----------|------|-----------------|----------------------|
| 1 | **Speed** — Did the run finish promptly for this task? | Linear scale | 1–5 | ≥4 when `speed_score ≥ 0.5` (~≤10s half-life) |
| 2 | **Latency** — Was wall-clock latency acceptable? | Linear scale | 1–5 | ≥4 when `latency_ms ≤ 8000` and `latency_flag` is false |
| 3 | **Robustness** — Did tools succeed without teaching failures? | Linear scale | 1–5 | 5 when `robustness_score = 1` and no `missing_customer_id` / `unscoped` |
| 4 | **Token efficiency** — Was token use reasonable? | Linear scale | 1–5 | ≥4 when `token_total` is low for the task (local models often ≈0 if not reported) |
| 5 | **Drift** — Did behavior drift from the known good path? | Multiple choice | `none` / `tool_misuse` / `retry_loop` / `novel_sequence` / `latency_spike` | Prefer `none`; map from `drift_signals` / Neatlogs detection badges |
| 6 | **Overall** — Ship this run’s strategy? | Rating | 1–5 | Pass if Speed+Latency+Robustness average ≥4 and Drift = none |

## AI evaluator prompt (paste)

```
You are scoring Loop (support-agent-planner) traces for Maximor Syndicate.

Read the WORKFLOW output JSON. Prefer numeric fields:
- latency_ms, speed_score, robustness_score, token_total, drift_signals
- detection badges: "Loop: missing_customer_id drift", "Loop: unscoped tool call",
  "Loop: tool ok:false", "Loop: retry / duplicate tool pattern", "Execution Failed"

Scoring rules:
1. Speed: map speed_score [0,1] → 1–5 (0.2→1, 0.5→3, 0.8→5).
2. Latency: latency_ms ≤ 5s → 5; ≤ 8s → 4; ≤ 15s → 3; ≤ 30s → 2; else 1.
3. Robustness: score 5 if no tool failures and no missing_customer_id/unscoped;
   3 if recovered after one failure; 1 if run failed or repeated unscoped list_orders.
4. Tokens: if token_total=0 (unknown), score 3 (neutral). Else lower score as tokens grow
   past 2k / 4k / 8k.
5. Drift: pick the strongest matching category from drift_signals / detections.
6. Overall: average of 1–4, minus 1 if drift ≠ none.

Return each answer with one short evidence sentence citing the field/badge used.
```

## Detections already live (fill DETECTIONS column)

Created via MCP for this project:

- Loop: missing_customer_id drift
- Loop: unscoped tool call
- Loop: tool ok:false
- Loop: retry / duplicate tool pattern
- Loop: novel tool sequence cue
- (+ defaults) Expensive LLM Call, Slow LLM Response, Execution Failed

**Re-run the agent** after creating the eval — EVALS badges appear once items are scored. DETECTIONS badges appear on **new** traces that match rules (existing rows usually stay `-`).
