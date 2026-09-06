# n8n workflows (Loop CRM)

Import these JSON files into n8n (**Workflows → Import from File**) or use the local Docker helper:

```powershell
npm run n8n:up
npm run n8n:import
```

Each exposes `POST /webhook/<tool_name>` with the same contract as the mock server.

See `../infra/n8n/README.md` and `../tools/README.md`.
