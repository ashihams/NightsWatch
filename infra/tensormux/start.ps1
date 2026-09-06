# Start TensorMux (Ollama backend) on :8090
# Requires: ollama serve + model qwen2.5:1.5b
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$env:TENSORMUX_CONFIG = (Resolve-Path .\config.yaml).Path
Write-Host "TENSORMUX_CONFIG=$env:TENSORMUX_CONFIG"
Write-Host "Gateway: http://127.0.0.1:8090  UI: http://127.0.0.1:8090/ui"
& "$here\.venv\Scripts\uvicorn.exe" tensormux.api.main:app --host 127.0.0.1 --port 8090
