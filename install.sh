#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

# ---------- 终端颜色辅助 ----------
if [ -t 1 ]; then
  C_RESET="\033[0m"
  C_INFO="\033[1;36m"
  C_OK="\033[1;32m"
  C_WARN="\033[1;33m"
  C_ERR="\033[1;31m"
else
  C_RESET=""
  C_INFO=""
  C_OK=""
  C_WARN=""
  C_ERR=""
fi

info() { printf "${C_INFO}==> %s${C_RESET}\n" "$*"; }
ok()   { printf "${C_OK}  [✓] %s${C_RESET}\n" "$*"; }
warn() { printf "${C_WARN}  [!] %s${C_RESET}\n" "$*"; }
fail() { printf "${C_ERR}  [✗] %s${C_RESET}\n" "$*" >&2; exit 1; }

info "Lite Ollama (Raycast 插件) 环境与依赖检查"

# ---------- 1. 补充常见包管理器 PATH (macOS Homebrew / Volta / fnm / nvm) ----------
for extra_dir in \
  "/opt/homebrew/bin" \
  "/usr/local/bin" \
  "$HOME/.volta/bin" \
  "$HOME/.local/share/fnm" \
  "$HOME/.fnm" \
  "$HOME/Library/Application Support/fnm"
do
  if [ -d "$extra_dir" ] && [[ ":$PATH:" != *":$extra_dir:"* ]]; then
    export PATH="$extra_dir:$PATH"
  fi
done

if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env 2>/dev/null || true)"
fi

check_node_semver() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [maj, min, pat] = process.versions.node.split(".").map(Number);
    const ok = maj > 22 || (maj === 22 && (min > 22 || (min === 22 && pat >= 2)));
    process.exit(ok ? 0 : 1);
  ' >/dev/null 2>&1
}

# 若默认 PATH 下无 Node 或版本过低，尝试加载 nvm
if ! check_node_semver; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    nvm use 22 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
  elif [ -s "/opt/homebrew/opt/nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "/opt/homebrew/opt/nvm/nvm.sh" >/dev/null 2>&1 || true
    nvm use 22 >/dev/null 2>&1 || true
  fi
fi

# ---------- 2. 操作系统平台检查 ----------
OS_UNAME="$(uname -s 2>/dev/null || echo Unknown)"
ARCH_UNAME="$(uname -m 2>/dev/null || echo Unknown)"
PLATFORM_KIND="unknown"

case "$OS_UNAME" in
  Darwin*)
    PLATFORM_KIND="macos"
    ok "操作系统: macOS ($ARCH_UNAME)"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM_KIND="windows"
    ok "操作系统: Windows Git Bash ($ARCH_UNAME)"
    ;;
  *)
    fail "当前系统 ($OS_UNAME) 不受 Raycast 官方桌面端支持（Raycast 仅支持 macOS 与 Windows）。"
    ;;
esac

# ---------- 3. Node.js 与 npm 版本严格检查 (>= 22.22.2) ----------
if ! command -v node >/dev/null 2>&1; then
  if [ "$PLATFORM_KIND" = "macos" ]; then
    fail "未检测到 Node.js。请先安装 Node.js (>= 22.22.2)：
      - Homebrew: brew install node
      - 或官网下载: https://nodejs.org/"
  else
    fail "未检测到 Node.js。请先安装 Node.js (>= 22.22.2)：
      - WinGet: winget install OpenJS.NodeJS
      - 或官网下载: https://nodejs.org/"
  fi
fi

CURRENT_NODE_VER="$(node -v 2>/dev/null || echo unknown)"
if ! check_node_semver; then
  fail "当前 Node.js 版本过低 ($CURRENT_NODE_VER)，@raycast/api@2.12+ 要求 Node.js >= 22.22.2。
      请升级后重试：
      - 使用 nvm:  nvm install 22 && nvm use 22
      - 使用 fnm:  fnm install 22 && fnm use 22
      - macOS:     brew upgrade node
      - 官网安装包: https://nodejs.org/"
fi
ok "Node.js 版本满足要求: $CURRENT_NODE_VER (要求 >= v22.22.2)"

if ! command -v npm >/dev/null 2>&1; then
  fail "检测到 node 但未找到 npm，请检查 Node.js 安装是否完整。"
fi
ok "npm 版本: v$(npm -v)"

# ---------- 4. 系统底层运行能力检查 (SQLite / 原生 OCR 工具) ----------
if node -e "require('node:sqlite')" >/dev/null 2>&1; then
  ok "SQLite 会话写入支持: Node 内置 node:sqlite 可用"
elif command -v python3 >/dev/null 2>&1 && python3 -c "import sqlite3" >/dev/null 2>&1; then
  ok "SQLite 会话写入支持: Python3 sqlite3 兜底可用"
else
  warn "未检测到 node:sqlite 或 python3 sqlite3，「进入 Ollama 桌面端继续对话」可能无法写入历史数据库"
fi

if [ "$PLATFORM_KIND" = "macos" ]; then
  if [ ! -x "/usr/bin/osascript" ] || [ ! -x "/usr/bin/sips" ]; then
    fail "缺少 macOS 系统内置工具 /usr/bin/osascript 或 /usr/bin/sips。"
  fi
  if /usr/bin/osascript -l JavaScript -e "ObjC.import('Vision'); 'ok'" >/dev/null 2>&1; then
    ok "macOS 原生 Vision OCR 框架可用"
  else
    warn "macOS Vision 框架自检异常，建议在插件中使用本地视觉大模型 OCR"
  fi
elif [ "$PLATFORM_KIND" = "windows" ]; then
  WIN_PS="${SYSTEMROOT:-C:\\Windows}/System32/WindowsPowerShell/v1.0/powershell.exe"
  if [ -f "$WIN_PS" ]; then
    ok "Windows PowerShell 5.1 (WinRT 原生 OCR / 图像裁切组件) 可用"
  else
    warn "未在默认位置检测到 WindowsPowerShell 5.1，原生离线 OCR 可能受限"
  fi
fi

# ---------- 5. Raycast 客户端安装与运行状态检查 ----------
if [ "$PLATFORM_KIND" = "macos" ]; then
  RAYCAST_APP=""
  if [ -d "/Applications/Raycast.app" ]; then
    RAYCAST_APP="/Applications/Raycast.app"
  elif [ -d "$HOME/Applications/Raycast.app" ]; then
    RAYCAST_APP="$HOME/Applications/Raycast.app"
  elif command -v mdfind >/dev/null 2>&1; then
    RAYCAST_APP="$(mdfind "kMDItemCFBundleIdentifier == 'com.raycast.macos'" 2>/dev/null | head -n 1 || true)"
  fi

  if [ -z "$RAYCAST_APP" ] || [ ! -d "$RAYCAST_APP" ]; then
    fail "未检测到已安装的 Raycast 客户端。请先安装 Raycast：
      - Homebrew: brew install --cask raycast
      - 或前往官网: https://www.raycast.com/"
  fi
  ok "检测到 Raycast 客户端: $RAYCAST_APP"

  RAYCAST_RUNNING=false
  if /usr/bin/lsappinfo find bundleid=com.raycast.macos 2>/dev/null | grep -q "." || pgrep -x "Raycast" >/dev/null 2>&1; then
    RAYCAST_RUNNING=true
  fi

  if [ "$RAYCAST_RUNNING" = false ]; then
    info "Raycast 当前未在后台运行，正在自动启动 Raycast..."
    open -g -a "$RAYCAST_APP" || open -a "$RAYCAST_APP" || true
    for _ in 1 2 3 4 5 6; do
      sleep 1
      if /usr/bin/lsappinfo find bundleid=com.raycast.macos 2>/dev/null | grep -q "." || pgrep -x "Raycast" >/dev/null 2>&1; then
        RAYCAST_RUNNING=true
        break
      fi
    done
  fi

  if [ "$RAYCAST_RUNNING" = true ]; then
    ok "Raycast 客户端正在运行"
  else
    warn "未能确认 Raycast 已完成启动，请确保已完成首次欢迎引导后再导入"
  fi
elif [ "$PLATFORM_KIND" = "windows" ]; then
  WIN_PS="${SYSTEMROOT:-C:\\Windows}/System32/WindowsPowerShell/v1.0/powershell.exe"
  RAY_STATUS="$("$WIN_PS" -NoProfile -NonInteractive -Command '
    $proc = Get-Process | Where-Object { $_.ProcessName -match "^Raycast$" } | Select-Object -First 1
    if ($proc) { Write-Output "RUNNING"; exit 0 }
    $pkg = Get-AppxPackage | Where-Object { $_.Name -match "Raycast" } | Select-Object -First 1
    if ($pkg) {
      $appId = (Get-AppxPackageManifest $pkg).Package.Applications.Application.Id
      if ($appId -is [array]) { $appId = $appId[0] }
      Start-Process "explorer.exe" "shell:AppsFolder\$($pkg.PackageFamilyName)!$appId"
      Start-Sleep -Seconds 3
      Write-Output "STARTED"
      exit 0
    }
    if (Test-Path "$env:LOCALAPPDATA\Programs\Raycast\Raycast.exe") {
      Start-Process "$env:LOCALAPPDATA\Programs\Raycast\Raycast.exe"
      Start-Sleep -Seconds 3
      Write-Output "STARTED"
      exit 0
    }
    Write-Output "MISSING"
  ' 2>/dev/null | tr -d '\r' || echo "UNKNOWN")"

  if [ "$RAY_STATUS" = "MISSING" ]; then
    fail "未检测到 Windows 版 Raycast。请先执行安装：
      winget install --id 9PFXXSHC64H3 -s msstore"
  elif [ "$RAY_STATUS" = "RUNNING" ] || [ "$RAY_STATUS" = "STARTED" ]; then
    ok "Raycast 客户端已就绪 ($RAY_STATUS)"
  else
    warn "未能自动确认 Raycast 状态，请确保 Raycast 已安装并启动"
  fi
fi

# ---------- 6. Ollama 环境状态预检 (非阻塞提示) ----------
OLLAMA_CHECK="$(node -e '
  (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    try {
      const r = await fetch("http://localhost:11434/api/tags", { signal: ctrl.signal });
      if (!r.ok) { console.log("HTTP_" + r.status); return; }
      const d = await r.json();
      const count = Array.isArray(d.models) ? d.models.length : 0;
      console.log("OK:" + count);
    } catch {
      console.log("OFFLINE");
    } finally {
      clearTimeout(t);
    }
  })();
' 2>/dev/null || echo "OFFLINE")"

if [[ "$OLLAMA_CHECK" == OK:* ]]; then
  MODEL_COUNT="${OLLAMA_CHECK#OK:}"
  if [ "$MODEL_COUNT" -gt 0 ]; then
    ok "本地 Ollama 服务在线 (已安装 ${MODEL_COUNT} 个模型)"
  else
    warn "本地 Ollama 服务在线，但当前尚未拉取任何模型（可运行 ollama pull qwen2.5:7b 或 ollama pull glm-ocr）"
  fi
else
  warn "本地 http://localhost:11434 暂未响应（使用前请启动 Ollama，或在插件设置中配置自定义 Endpoint）"
fi

# ---------- 7. 项目 npm 依赖完整性检查与安装 ----------
info "检查项目 npm 依赖包完整性..."
NEED_NPM_INSTALL=false

if [ ! -d "$ROOT_DIR/node_modules" ] || [ ! -f "$ROOT_DIR/node_modules/.package-lock.json" ]; then
  NEED_NPM_INSTALL=true
elif [ "$ROOT_DIR/package.json" -nt "$ROOT_DIR/node_modules/.package-lock.json" ]; then
  NEED_NPM_INSTALL=true
elif [ -f "$ROOT_DIR/package-lock.json" ] && [ "$ROOT_DIR/package-lock.json" -nt "$ROOT_DIR/node_modules/.package-lock.json" ]; then
  NEED_NPM_INSTALL=true
elif ! npm ls --depth=0 >/dev/null 2>&1; then
  NEED_NPM_INSTALL=true
fi

if [ "$NEED_NPM_INSTALL" = true ]; then
  info "发现缺失或未同步的 npm 依赖，正在安装..."
  if [ -f "$ROOT_DIR/package-lock.json" ]; then
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
fi

# 校验关键包能否实际加载（防止 --ignore-scripts / allowScripts 导致 esbuild 二进制未就绪）
if ! node -e "require.resolve('@raycast/api'); require.resolve('onnxruntime-web'); require.resolve('typescript');" >/dev/null 2>&1; then
  info "核心依赖解析异常，正在重新执行完整 npm install..."
  npm install --no-audit --no-fund
fi

if ! node -e "require('esbuild').transformSync('const a = 1;')" >/dev/null 2>&1; then
  warn "检测到 esbuild 原生二进制未初始化，正在自动执行初始化脚本..."
  if [ -f "$ROOT_DIR/node_modules/esbuild/install.js" ]; then
    node "$ROOT_DIR/node_modules/esbuild/install.js"
  fi
  node -e "require('esbuild').transformSync('const a = 1;')" >/dev/null 2>&1 || fail "esbuild 二进制无法在当前架构 ($ARCH_UNAME) 运行，请删除 node_modules 后重新执行 ./install.sh"
fi
ok "全部 npm 依赖与编译器校验通过"

# ---------- 8. 同步 ONNX Runtime WASM 资源并做 TypeScript 类型检查 ----------
node "$ROOT_DIR/scripts/copy-ort-wasm.mjs"
if [ ! -s "$ROOT_DIR/assets/ort/ort-wasm-simd-threaded.wasm" ] || [ ! -s "$ROOT_DIR/assets/ort/ort-wasm-simd-threaded.mjs" ]; then
  fail "ONNX Runtime WASM 运行时文件复制失败 (assets/ort/)"
fi
ok "ONNX Runtime WASM 版面分析运行时已就绪"

info "正在执行 TypeScript 静态类型检查..."
npm run typecheck
ok "TypeScript 类型检查通过"

# ---------- 9. 编译并导入本地 Raycast ----------
npm run install:local
