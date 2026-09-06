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

# Inspect stores
npm run working:list
npm run episodic:list
npm run memory:lessons
```

See `tools/README.md` for webhook contracts and `agent/README.md` for the planner, AO entrypoint, Neatlogs, SQLite working/episodic memory, semantic lessons, and Step 8 strategy injection.
