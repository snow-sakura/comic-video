#!/usr/bin/env bash
# 按模型档位启动 Celery Worker 进程组（免费串行 / 付费并行）。
# 等价于 scripts/start-backend.sh 的 worker 部分，独立版便于仅重启 worker。
# 计划来自 backend/app/scheduler/tier.py（python -m app.batch_plan）。
set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

mkdir -p logs
"$PY" -m app.batch_plan --summary || true

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

start_group() {
  local name="$1" queues="$2" n="$3" pool="$4"
  echo "[workers] 组 ${name}：pool=${pool} 并发=${n} 队列=${queues}"
  "$PY" -m celery -A app.core.celery_app \
    worker -Q "$queues" -l info --pool="${WORKER_POOL:-$pool}" -c "$n" -n "w-${name}@%h" \
    --logfile="logs/worker-${name}.log" --pidfile="logs/celery-${name}.pid" &
  PIDS+=($!)
}

while IFS='|' read -r _name _queues _n _pool; do
  [ -n "$_name" ] && start_group "$_name" "$_queues" "$_n" "$_pool"
done < <("$PY" -m app.batch_plan --shell)

wait
