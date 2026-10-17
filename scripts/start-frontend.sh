#!/usr/bin/env bash
# 启动前端：Vite dev server（代理 /api、/file → 后端 :8000）
# 用法：./scripts/start-frontend.sh
# 依赖：frontend/node_modules（npm install）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
PORT="${PORT:-3000}"

log() { printf '\033[36m[frontend]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[frontend]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. 依赖
if [[ ! -d "$FRONTEND/node_modules" ]]; then
  log "首次运行：安装依赖（npm install）..."
  (cd "$FRONTEND" && npm install)
fi

# 2. 类型检查（快速失败，可跳过 SKIP_TYPECHECK=1）
if [[ "${SKIP_TYPECHECK:-0}" != "1" ]]; then
  log "类型检查（tsc --noEmit）..."
  (cd "$FRONTEND" && ./node_modules/.bin/tsc --noEmit) || die "类型检查失败"
fi

# 3. 启动 Vite
log "启动 Vite → http://localhost:${PORT}（/api、/file 代理到 :8000）..."
log "提示：需先启动后端 ./scripts/start-backend.sh"
cd "$FRONTEND" && exec ./node_modules/.bin/vite --port "$PORT"
