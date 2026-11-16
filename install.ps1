$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }

Write-Step "Lite Ollama (Raycast 插件) 环境与依赖检查"

# 1. Node.js & npm 版本严格检查 (>= 22.22.2)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未检测到 Node.js。请先安装 Node.js (>= 22.22.2): winget install OpenJS.NodeJS 或访问 https://nodejs.org/"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "未检测到 npm，请确认 Node.js 安装完整。"
}

$nodeVerRaw = (& node -v).Trim()
& node -e "const [M,m,p]=process.versions.node.split('.').map(Number); process.exit((M>22||(M===22&&(m>22||(m===22&&p>=2))))?0:1)"
if ($LASTEXITCODE -ne 0) {
  throw "当前 Node.js 版本过低 ($nodeVerRaw)，@raycast/api@2.12+ 要求 Node.js >= 22.22.2，请升级后重试。"
}
Write-Ok "Node.js 版本满足要求: $nodeVerRaw"

# 2. Raycast 安装与运行状态检查
$rayProc = Get-Process | Where-Object { $_.ProcessName -match "^Raycast$" } | Select-Object -First 1
if ($rayProc) {
  Write-Ok "Raycast 客户端正在运行"
} else {
  $pkg = Get-AppxPackage | Where-Object { $_.Name -match "Raycast" } | Select-Object -First 1
  $exePath = "$env:LOCALAPPDATA\Programs\Raycast\Raycast.exe"
  if ($pkg) {
    Write-Step "Raycast 当前未运行，正在自动启动..."
    $appId = (Get-AppxPackageManifest $pkg).Package.Applications.Application.Id
    if ($appId -is [array]) { $appId = $appId[0] }
    Start-Process "explorer.exe" "shell:AppsFolder\$($pkg.PackageFamilyName)!$appId"
    Start-Sleep -Seconds 4
    Write-Ok "已启动 Raycast 客户端"
  } elseif (Test-Path -LiteralPath $exePath) {
    Write-Step "Raycast 当前未运行，正在自动启动..."
    Start-Process $exePath
    Start-Sleep -Seconds 4
    Write-Ok "已启动 Raycast 客户端"
  } else {
    throw "未检测到 Windows 版 Raycast。请先安装: winget install --id 9PFXXSHC64H3 -s msstore"
  }
}

# 3. Ollama 服务在线状态提示 (非阻塞)
try {
  $resp = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 2 -ErrorAction Stop
  $cnt = if ($resp.models) { $resp.models.Count } else { 0 }
  Write-Ok "本地 Ollama 服务在线 (已安装 $cnt 个模型)"
} catch {
  Write-Warn "本地 http://localhost:11434 暂未响应（使用前请启动 Ollama 或在插件设置中配置自定义 Endpoint）"
}

# 4. npm 依赖完整性校验与修复
Write-Step "检查项目 npm 依赖完整性..."
$needInstall = $false
$lockMarker = Join-Path $PSScriptRoot "node_modules\.package-lock.json"
if (-not (Test-Path -LiteralPath $lockMarker)) {
  $needInstall = $true
} elseif ((Get-Item (Join-Path $PSScriptRoot "package.json")).LastWriteTime -gt (Get-Item $lockMarker).LastWriteTime) {
  $needInstall = $true
} else {
  & npm ls --depth=0 *> $null
  if ($LASTEXITCODE -ne 0) { $needInstall = $true }
}

if ($needInstall) {
  Write-Step "正在同步安装 npm 依赖..."
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "package-lock.json")) {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { & npm install --no-audit --no-fund }
  } else {
    & npm install --no-audit --no-fund
  }
  if ($LASTEXITCODE -ne 0) { throw "npm 依赖安装失败" }
}

& node -e "require('esbuild').transformSync('const a = 1;')" *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Warn "正在初始化 esbuild 原生二进制..."
  & node (Join-Path $PSScriptRoot "node_modules\esbuild\install.js")
}
Write-Ok "全部 npm 依赖与编译器校验通过"

# 5. 同步 WASM 运行时并执行类型检查与导入
& node (Join-Path $PSScriptRoot "scripts\copy-ort-wasm.mjs")
& npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "TypeScript 类型检查未通过" }

& npm run install:local
