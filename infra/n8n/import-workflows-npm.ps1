# Import workflows when n8n runs via npx (no Docker).
# Assumes n8n is already listening on :5678 and CLI is available via npx.
$ErrorActionPreference = "Stop"
$Workflows = Resolve-Path (Join-Path $PSScriptRoot "..\..\n8n-workflows")

Write-Host "Waiting for n8n on :5678..."
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:5678/healthz" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ok) { throw "n8n not healthy on :5678" }

Push-Location $PSScriptRoot
try {
  Write-Host "Importing from $Workflows"
  npx --yes n8n import:workflow --separate --input="$Workflows"
  npx --yes n8n update:workflow --all --active=true
} finally {
  Pop-Location
}

Write-Host "Smoke tests..."
foreach ($path in @("search_customers","get_customer","list_orders","get_order","create_ticket")) {
  $body = switch ($path) {
    "search_customers" { '{"query":"Jordan Lee"}' }
    "get_customer" { '{"customer_id":"cust_1001"}' }
    "list_orders" { '{"customer_id":"cust_1001"}' }
    "get_order" { '{"order_id":"ord_5001"}' }
    default { '{"customer_id":"cust_1001","subject":"Late shipment","body":"Order still missing"}' }
  }
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:5678/webhook/$path" -Method POST -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 15
    Write-Host "  OK $path $($res.StatusCode)"
  } catch {
    Write-Host "  FAIL $path $($_.Exception.Message)"
  }
}
