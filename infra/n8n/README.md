# Loop × n8n

Local n8n serves the same CRM webhook contracts as `npm run tools` (mock).

## Quick start (Docker)

1. Stop the mock server if it holds `:5678`.
2. Start Docker Desktop, then:

```powershell
docker compose -f infra/n8n/docker-compose.yml up -d
powershell -File infra/n8n/import-workflows.ps1
```

3. Keep `.env`:

```
TOOLS_BASE_URL=http://127.0.0.1:5678
```

4. UI: http://127.0.0.1:5678  
   Webhooks: `POST /webhook/{search_customers|get_customer|list_orders|get_order|create_ticket}`

## Fallback (no Docker)

```powershell
cd infra/n8n
npm install
$env:N8N_PORT=5678
$env:WEBHOOK_URL="http://127.0.0.1:5678/"
$env:N8N_USER_MANAGEMENT_DISABLED="true"
npx n8n
# In another terminal, after n8n is up:
pwsh -File import-workflows-npm.ps1
```

Workflow JSON lives in `../../n8n-workflows/` (imported as **Loop - &lt;tool&gt;**).

## Mock vs n8n

| | Mock (`npm run tools`) | n8n |
|--|------------------------|-----|
| Port | 5678 | 5678 (same — only one at a time) |
| Behavior | Richer noise (latency, 429) | Same seed + teaching misses |
| Prefer | Offline demos | “Real” workflow engine demos |

Agent code is unchanged: it always calls `TOOLS_BASE_URL/webhook/<tool>`.
