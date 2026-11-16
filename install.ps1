$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "==> Lite Ollama (Raycast 插件) 一键本地安装" -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "未检测到 Node.js / npm，请先安装 Node.js (>= 22.14): https://nodejs.org/"
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules\@raycast\api"))) {
  Write-Host "==> 正在安装依赖 (npm install)..." -ForegroundColor Yellow
  npm install
}

npm run install:local
