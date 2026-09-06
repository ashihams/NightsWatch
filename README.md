# Nights Watch

Agent that learns how to use third-party tools over repeated runs.

**Hackathon:** Syndicate by Maximor — Track 1 (Automated Agent Engineering)

Built with Agent Orchestrator (AO).

## Quick start

```bash
# Terminal 1 — mock CRM webhooks
npm install
npm run tools

# Terminal 2 — one planner run (offline if TensorMux env unset)
npm run agent

# Second run should retrieve the first episode (stdout: episodic_retrieve / episodic_inject)
npm run agent

# Deterministic analyzer proof (flagged naive vs clean)
npm run analyzer:prove

# Two-run lesson promotion (candidate → usable)
npm run reflection:prove

# Strategy injection: naive vs injected unseen task
npm run strategy:prove

# Demo spine — seen_a / seen_b / unseen trajectory (Step 9)
# Requires mock tools already running (Terminal 1).
npm run replay:demo

# Demo dashboard — trajectory table + lessons feed (Step 10)
npm run dashboard
# open http://localhost:3847

# Inspect stores
npm run working:list
npm run episodic:list
npm run memory:lessons
```

Mock CRM/support webhooks on **http://localhost:5678**. See [`tools/README.md`](tools/README.md) for endpoints, curl examples, and the `customer_id` dependency the agent must learn.

### Demo replay (`npm run replay:demo`)

Preconditions: mock tools on `:5678` (`npm run tools` in another terminal).

Runs the committed scenario pack in `scripts/scenarios/replay-demo.json` through `runOnePlanner`:

1. **seen_a** — historically fails without `customer_id` resolution (naive path) → candidate lesson  
2. **seen_b** — slight wording variant of the same task → promotes usable lesson  
3. **unseen** — differently worded task; benefits via shared-factor lesson injection  

Prints per-run rows (`run_id`, label, success, tool counts, latency, tokens, lessons retrieved/promoted) then a comparison table. Writes `data/replay-demo/trajectory.json` for the dashboard. Exits non-zero unless at least one improvement signal holds (fewer failed tools on unseen, success rising, or lessons retrieved on unseen only). Stores under `./data/replay-demo/`.

### Demo dashboard (`npm run dashboard`)

Minimal read-only web view (no auth) for screen recordings:

```bash
# Terminal 1 — mock tools (needed before replay)
npm run tools

# Terminal 2 — produce trajectory + lessons (once, or again after code changes)
npm run replay:demo

# Terminal 3 — dashboard
npm run dashboard
# alias: npm run dev:dashboard
# open http://localhost:3847
```

| Endpoint | Purpose |
|----------|---------|
| `GET /api/trajectory` | Latest replay rows (`seen_a` / `seen_b` / `unseen`) |
| `GET /api/lessons` | Usable lessons (`evidence_count >= 2`) + pending candidates |
| UI | Plain trajectory table + lessons feed (polls every 3s) |

If no replay has been run yet, both panels show an empty state hinting to run `npm run replay:demo`. The server reads `./data/replay-demo/` only (same isolation as the demo spine); it does not duplicate planner/reflection logic.

Optional: `DASHBOARD_PORT=3847` (default).

See `tools/README.md` for webhook contracts and `agent/README.md` for the planner, AO entrypoint, Neatlogs, SQLite working/episodic memory, semantic lessons, strategy injection, demo replay, and dashboard.
