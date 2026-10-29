# Starts local n8n with the AI key from .env.local. Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-n8n.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (Test-Path ".env.local") {
  foreach ($line in Get-Content ".env.local") {
    if ($line -match '^\s*(GROQ_API_KEY|ANTHROPIC_API_KEY)\s*=\s*(.+?)\s*$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
  }
}
# The AI model API node reads the key with $env, which n8n blocks unless this is false.
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = "false"
if (-not $env:GROQ_API_KEY -and -not $env:ANTHROPIC_API_KEY) {
  Write-Host "No GROQ_API_KEY / ANTHROPIC_API_KEY in .env.local: agents will run without AI text."
}
npx n8n
