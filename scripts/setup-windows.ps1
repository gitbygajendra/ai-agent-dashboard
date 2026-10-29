# One-time setup on Windows. Run in PowerShell from the project folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
# Needs Node.js 20+ and PostgreSQL 15+ installed (see WINDOWS-SETUP.md).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$node = (node -v) -replace "v", ""
if ([int]$node.Split(".")[0] -lt 20) { throw "Node.js 20 or newer is required (found $node). Install from https://nodejs.org" }

# Find psql from the PostgreSQL installer (not on PATH by default).
$psql = Get-Command psql -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $psql) {
  $psql = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $psql) { throw "psql.exe not found. Install PostgreSQL from https://www.postgresql.org/download/windows/" }

function Random-Hex([int]$bytes) { -join ((1..$bytes) | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) }) }

if (-not (Test-Path ".env.local")) {
  $pw = Read-Host "Password you chose for the 'postgres' user during PostgreSQL install"
  $env:PGPASSWORD = $pw
  $exists = (& $psql -h 127.0.0.1 -U postgres -tAc "select 1 from pg_database where datname = 'agentdash'")
  if ($exists -ne "1") { & $psql -h 127.0.0.1 -U postgres -c "create database agentdash" | Out-Null }
  $pwEnc = [uri]::EscapeDataString($pw)
  @"
APP_BASE_URL=http://localhost:3000
DATABASE_URL=postgres://postgres:$pwEnc@127.0.0.1:5432/agentdash
DATABASE_SSL=false
AUTH_MODE=local
LOCAL_AUTH_SECRET=$(Random-Hex 32)
ENCRYPTION_KEY=$([Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })))
LOCAL_STORAGE_DIR=.data/uploads
N8N_BASE_URL=http://localhost:5678
N8N_WORKFLOW_MODE=master
N8N_WEBHOOK_SECRET=$(Random-Hex 32)
AI_ENABLED=true
AI_PROVIDER=groq
# Optional, read by scripts\start-n8n.ps1: GROQ_API_KEY=gsk_...
"@ | Set-Content -Encoding ascii ".env.local"
  Write-Host "Wrote .env.local"
}

npm install
npm run db:migrate:local

$secret = (Get-Content ".env.local" | Where-Object { $_ -like "N8N_WEBHOOK_SECRET=*" }) -replace "N8N_WEBHOOK_SECRET=", ""
Write-Host ""
Write-Host "Setup done. Next:"
Write-Host "  1. Optional AI text: add GROQ_API_KEY=gsk_... to .env.local"
Write-Host "  2. In a second PowerShell window run:  powershell -ExecutionPolicy Bypass -File .\scripts\start-n8n.ps1"
Write-Host "  3. Open http://localhost:5678, create the owner account, then add one Header Auth credential:"
Write-Host "       'Agent Dashboard Webhook Secret'  header x-webhook-secret  value: $secret"
Write-Host "     Import n8n\agent-dashboard-master.json, pick that credential on the Webhook node, click Publish."
Write-Host "  4. Back here run:  npm run dev   and open http://localhost:3000"
