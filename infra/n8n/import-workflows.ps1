# Import + activate Loop CRM workflows into local n8n (Docker).
# Stop mock server on :5678 first. n8n must be stoppable for activation to stick.
$ErrorActionPreference = "Stop"
$Compose = Join-Path $PSScriptRoot "docker-compose.yml"
$WorkflowsHost = (Resolve-Path (Join-Path $PSScriptRoot "..\..\n8n-workflows")).Path

Write-Host "Ensuring loop-n8n exists..."
$running = docker ps -a --filter "name=loop-n8n" --format "{{.Names}}"
if (-not $running) {
  docker compose -f $Compose up -d
}

Write-Host "Stopping n8n for import/activate..."
docker stop loop-n8n | Out-Null

$common = @(
  "--rm", "--user", "node",
  "-v", "n8n_loop_n8n_data:/home/node/.n8n",
  "-e", "N8N_ENCRYPTION_KEY=loop-local-dev-encryption-key-32b",
  "-e", "N8N_USER_MANAGEMENT_DISABLED=true",
  "n8nio/n8n:1.109.1"
)

Write-Host "Importing workflows from $WorkflowsHost ..."
docker run @common -v "${WorkflowsHost}:/workflows:ro" import:workflow --separate --input=/workflows/

Write-Host "Activating all workflows..."
docker run @common update:workflow --all --active=true

Write-Host "Starting n8n..."
docker start loop-n8n | Out-Null

Write-Host "Waiting for healthz..."
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:5678/healthz" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ok) { throw "n8n did not become healthy on :5678" }

Write-Host "Smoke-testing webhooks..."
$tests = @(
  @{ path = "search_customers"; body = '{"query":"Jordan Lee"}' },
  @{ path = "get_customer"; body = '{"customer_id":"cust_1001"}' },
  @{ path = "list_orders"; body = '{"customer_id":"cust_1001"}' },
  @{ path = "get_order"; body = '{"order_id":"ord_5001"}' },
  @{ path = "create_ticket"; body = '{"customer_id":"cust_1001","subject":"Late shipment","body":"Order still missing"}' }
)
foreach ($t in $tests) {
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:5678/webhook/$($t.path)" `
      -Method POST -ContentType "application/json" -Body $t.body -UseBasicParsing -TimeoutSec 20
    Write-Host ("  OK  /webhook/{0} -> {1}" -f $t.path, $res.StatusCode)
  } catch {
    Write-Host ("  FAIL /webhook/{0} -> {1}" -f $t.path, $_.Exception.Message)
  }
}

Write-Host ""
Write-Host "TOOLS_BASE_URL=http://127.0.0.1:5678"
Write-Host "n8n UI: http://127.0.0.1:5678"
Write-Host "Done."
