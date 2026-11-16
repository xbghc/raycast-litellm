#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Lite Ollama (Raycast 插件) 一键本地安装"

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js / npm，请先安装 Node.js (>= 22.14): https://nodejs.org/" >&2
  exit 1
fi

if [ ! -d "node_modules/@raycast/api" ]; then
  echo "==> 正在安装依赖 (npm install)..."
  npm install
fi

npm run install:local
