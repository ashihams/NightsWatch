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

# Inspect stores
npm run working:list
npm run episodic:list
```

See `tools/README.md` for webhook contracts and `agent/README.md` for the planner, AO entrypoint, Neatlogs, SQLite working memory, and episodic vector memory.
