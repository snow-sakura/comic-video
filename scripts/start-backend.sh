#!/usr/bin/env bash
# 启动后端：FastAPI (uvicorn) + Celery Worker（5 条队列）
# 用法：./scripts/start-backend.sh
# 依赖：PostgreSQL（comic_video 库）、Redis、backend/.venv
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
VENV="$BACKEND/.venv"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
QUEUES="script,image,video,audio,compose"

log() { printf '\033[32m[backend]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[backend]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[backend]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. 虚拟环境
[[ -x "$VENV/bin/python" ]] || die "缺少 ${VENV}，请先创建：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"

# 2. 环境变量（配置固定位于 backend/.env）
if [[ ! -f "$BACKEND/.env" ]]; then
  warn "未找到 backend/.env（密钥留空将自动走 Mock 模式）；可复制 backend/.env.example 为 backend/.env"
fi

# 3. Redis / PostgreSQL 连通性（仅警告，不阻断——Mock 模式可跑）
if command -v redis-cli >/dev/null 2>&1 && ! redis-cli ping >/dev/null 2>&1; then
  warn "Redis 未响应（Celery broker 需要它）：brew services start redis"
fi
if command -v pg_isready >/dev/null 2>&1 && ! pg_isready -q; then
  warn "PostgreSQL 未响应：brew services start postgresql@18"
fi

# 4. 数据库迁移（幂等）
if [[ -d "$BACKEND/alembic" ]]; then
  log "执行数据库迁移（alembic upgrade head）..."
  (cd "$BACKEND" && "$VENV/bin/alembic" upgrade head) || warn "迁移失败（库可能已存在或未启动），继续启动"
fi

PIDS=()
CLEANED=0
cleanup() {
  # 幂等：INT/TERM 触发后 EXIT 不再重复执行
  [[ "$CLEANED" -eq 1 ]] && return
  CLEANED=1
  log "停止后端进程..."
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

# 5. Celery Worker（按模型档位：免费串行 / 付费并行；计划见 app/scheduler/tier.py）
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

# 6. FastAPI (uvicorn)
log "启动 FastAPI → http://$HOST:${PORT}（docs: /docs）..."
(cd "$BACKEND" && exec "$VENV/bin/python" -m uvicorn app.main:app \
  --host "$HOST" --port "$PORT") &
PIDS+=($!)

log "后端已启动。Ctrl+C 停止全部。"
wait
