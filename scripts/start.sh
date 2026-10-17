#!/usr/bin/env bash
# 一键启动全部：FastAPI + Celery Worker + Vite dev
# 用法：./scripts/start.sh        （Ctrl+C 统一退出全部进程）
# 前置：PostgreSQL（comic_video 库）、Redis、ffmpeg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
VENV="$BACKEND/.venv"
HOST="${HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"
QUEUES="script,image,video,audio,compose"

log() { printf '\033[35m[start]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[start]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[start]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$ROOT"

# ===== 前置检查 =====
[[ -x "$VENV/bin/python" ]] || die "缺少 backend/.venv：cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
[[ -d frontend/node_modules ]] || { log "安装前端依赖（npm install）..."; (cd frontend && npm install); }

if ! command -v ffmpeg >/dev/null 2>&1; then
  warn "未检测到 ffmpeg（视频合成需要）：brew install ffmpeg"
fi
if command -v redis-cli >/dev/null 2>&1 && ! redis-cli ping >/dev/null 2>&1; then
  warn "Redis 未响应：brew services start redis"
fi
if command -v pg_isready >/dev/null 2>&1 && ! pg_isready -q; then
  warn "PostgreSQL 未响应：brew services start postgresql@18"
fi

# 数据库迁移（幂等，失败仅警告——库已就绪时可忽略）
if [[ -d "$BACKEND/alembic" ]]; then
  log "数据库迁移（alembic upgrade head）..."
  (cd "$BACKEND" && "$VENV/bin/alembic" upgrade head) || warn "迁移跳过/失败（可忽略若库已初始化）"
fi

PIDS=()
CLEANED=0
cleanup() {
  # 幂等：INT/TERM 触发后 EXIT 不再重复执行
  [[ "$CLEANED" -eq 1 ]] && return
  CLEANED=1
  log "停止全部进程..."
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  log "已全部退出。"
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

# ===== 启动 Celery Worker（按模型档位：免费串行 / 付费并行）=====
# 计划来自 backend/app/scheduler/tier.py（物理队列 itinerary：name|queues|concurrency|pool）
mkdir -p "$BACKEND/logs"
PLAN_SUMMARY="$(cd "$BACKEND" && "$VENV/bin/python" -m app.batch_plan --summary 2>/dev/null || true)"
[[ -n "$PLAN_SUMMARY" ]] && printf '%s\n' "$PLAN_SUMMARY"

start_worker_group() {
  local name="$1" queues="$2" n="$3" pool="$4"
  if [[ "$n" -le 1 ]]; then
    log "worker 组 ${name}：串行（solo）队列 ${queues}"
    (cd "$BACKEND" && exec "$VENV/bin/python" -m celery -A app.core.celery_app \
      worker -Q "$queues" -l info --pool="${WORKER_POOL:-$pool}" -n "w-${name}@%h" \
      --logfile="$BACKEND/logs/worker-${name}.log" \
      --pidfile="$BACKEND/logs/celery-${name}.pid") &
  else
    log "worker 组 ${name}：付费并行 ${n} 进程（prefork）队列 ${queues}"
    (cd "$BACKEND" && exec "$VENV/bin/python" -m celery -A app.core.celery_app \
      worker -Q "$queues" -l info --pool="${WORKER_POOL:-$pool}" -c "$n" -n "w-${name}@%h" \
      --logfile="$BACKEND/logs/worker-${name}.log" \
      --pidfile="$BACKEND/logs/celery-${name}.pid") &
  fi
  PIDS+=($!)
}

while IFS='|' read -r _name _queues _n _pool; do
  [[ -n "$_name" ]] && start_worker_group "$_name" "$_queues" "$_n" "$_pool"
done < <(cd "$BACKEND" && "$VENV/bin/python" -m app.batch_plan --shell)

# ===== 启动 FastAPI =====
log "启动 FastAPI → http://$HOST:${API_PORT}（docs: /docs）..."
(cd "$BACKEND" && exec "$VENV/bin/python" -m uvicorn app.main:app \
  --host "$HOST" --port "$API_PORT") &
PIDS+=($!)

# ===== 启动 Vite =====
log "启动前端 → http://localhost:${WEB_PORT}（/api、/file 代理 → :${API_PORT}）..."
(cd "$FRONTEND" && exec ./node_modules/.bin/vite --port "$WEB_PORT") &
PIDS+=($!)

wait
