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
```

See `tools/README.md` for webhook contracts and `agent/README.md` for the planner, AO entrypoint, Neatlogs, and SQLite working memory (`npm run working:list`).
