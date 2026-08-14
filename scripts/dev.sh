#!/usr/bin/env bash
#
# 一键本地开发启动脚本 — 启动网页 + 任务队列 Worker，只需一条命令
#
# 用法:
#   npm run dev:all        # 或 ./scripts/dev.sh
#
# 脚本自动完成:
#   1. .env 检查（缺失则从 .env.example 复制）
#   2. Redis 检查（未运行则尝试 brew services 启动）
#   3. PostgreSQL 检查（未运行则尝试 brew services 启动）
#   4. Prisma generate + migrate deploy（幂等，保持 schema 最新）
#   5. 同时启动 next dev + worker，Ctrl+C 统一退出
#
# 依赖仅需: Node 20+ / Redis / PostgreSQL / ffmpeg（均可通过 brew 安装）
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# 加载 .env 到环境变量（prisma CLI / 探测命令需要）
load_dotenv() {
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
}

echo "=========================================="
echo "  漫剧视频生成器 — 一键启动"
echo "=========================================="

# ===== 1. .env 检查 =====
echo ""
echo "[1/5] 环境配置检查..."
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "  → 已从 .env.example 创建 .env"
    echo "  ⚠  请编辑 .env 填写真实 API Key（无 Key 也可用 Mock 模式演示）"
  else
    echo "  ✗ 缺少 .env 与 .env.example，无法启动" >&2
    exit 1
  fi
fi
load_dotenv
echo "  ✓ .env 已加载"

# ===== 2. Redis 检查 =====
echo ""
echo "[2/5] Redis 检查..."
REDIS_OK=0
if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli -u "${REDIS_URL:-redis://localhost:6379}" ping 2>/dev/null | grep -q PONG; then
    REDIS_OK=1
  fi
fi
if [ "$REDIS_OK" != "1" ]; then
  echo "  → Redis 未运行，尝试自动启动..."
  if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -qi "^redis"; then
    brew services start redis
    for _ in 1 2 3 4 5; do
      sleep 1
      if redis-cli -u "${REDIS_URL:-redis://localhost:6379}" ping 2>/dev/null | grep -q PONG; then
        REDIS_OK=1
        break
      fi
    done
  else
    echo "  ⚠  未找到 brew 管理的 redis，请手动启动（如 redis-server）" >&2
  fi
fi
if [ "$REDIS_OK" != "1" ]; then
  echo "  ✗ Redis 不可用，无法启动任务队列" >&2
  exit 1
fi
echo "  ✓ Redis 正常 (${REDIS_URL:-redis://localhost:6379})"

# ===== 3. PostgreSQL 检查 =====
echo ""
echo "[3/5] PostgreSQL 检查..."
PG_OK=0
PG_PORT="$(node -e "const u=new URL(process.env.DATABASE_URL||'postgresql://localhost:5432/x');process.stdout.write(u.port||'5432')")"
require_pg_ok() {
  command -v pg_isready >/dev/null 2>&1 && pg_isready -h localhost -p "$PG_PORT" 2>/dev/null | grep -qE "接受连接|accepting"
}
if require_pg_ok; then
  PG_OK=1
fi
if [ "$PG_OK" != "1" ]; then
  echo "  → PostgreSQL 未运行，尝试自动启动..."
  if command -v brew >/dev/null 2>&1; then
    PG_SERVICE="$(brew services list 2>/dev/null | grep -oE '^postgresql[@0-9]*' | head -1 || true)"
    if [ -n "$PG_SERVICE" ]; then
      brew services start "$PG_SERVICE"
      for _ in 1 2 3 4 5 6 7 8; do
        sleep 1
        if require_pg_ok; then
          PG_OK=1
          break
        fi
      done
      if [ "$PG_OK" != "1" ]; then
        echo "  ⚠  $PG_SERVICE 启动超时，请检查数据库密码/端口" >&2
      fi
    else
      echo "  ⚠  未找到 brew 管理的 PostgreSQL，请手动启动" >&2
    fi
  else
    echo "  ⚠  未找到 brew，请手动启动 PostgreSQL" >&2
  fi
fi
if [ "$PG_OK" != "1" ]; then
  echo "  ✗ PostgreSQL 不可用" >&2
  exit 1
fi
echo "  ✓ PostgreSQL 正常 (localhost:$PG_PORT)"

# ===== 4. Prisma 同步 =====
echo ""
echo "[4/5] 数据库 schema 同步..."
npx prisma generate >/dev/null 2>&1 || { echo "  ✗ prisma generate 失败" >&2; exit 1; }
if npx prisma migrate deploy 2>&1 | grep -qE "No pending migrations|已经是最新|up to date|No pending"; then
  echo "  ✓ schema 已是最新"
else
  echo "  ✓ 迁移已应用"
fi

# ===== 5. 启动服务 =====
echo ""
echo "[5/5] 启动服务..."
echo "  网页:  http://localhost:3000"
echo "  Worker: 五个队列（script/image/video/audio/compose）"
echo "  Ctrl+C 同时退出全部进程"

# 日志落文件再实时转发：网页（next dev）与 worker 日志都实时显示，进程可独立管控
DEV_LOG="$PROJECT_DIR/.dev.log"
WORKER_LOG="$PROJECT_DIR/.worker.log"

npm run dev > "$DEV_LOG" 2>&1 &
DEV_PID=$!
npm run worker > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!
tail -f "$DEV_LOG" | perl -pe 'BEGIN{$|=1} s/^/[web] /' &
DEV_TAIL_PID=$!
tail -f "$WORKER_LOG" | perl -pe 'BEGIN{$|=1} s/^/[worker] /' &
TAIL_PID=$!

# 清理：kill npm 父进程，npm 会向子进程（tsx / next）转发 TERM
cleanup() {
  echo ""
  echo "  正在停止服务..."
  kill "$TAIL_PID" 2>/dev/null || true
  kill "$DEV_TAIL_PID" 2>/dev/null || true
  kill "$DEV_PID" 2>/dev/null || true
  kill "$WORKER_PID" 2>/dev/null || true
  # 兜底：等 3 秒后强杀残留，防止进程悬挂
  for _ in 1 2 3; do
    sleep 1
    if ! kill -0 "$DEV_PID" 2>/dev/null && ! kill -0 "$WORKER_PID" 2>/dev/null; then
      break
    fi
  done
  kill -9 "$DEV_PID" "$WORKER_PID" 2>/dev/null || true
  wait "$TAIL_PID" 2>/dev/null || true
  wait "$DEV_TAIL_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 前台等待 next dev 结束（Ctrl+C 时 SIGINT 会触发 cleanup 统一关停）
wait "$DEV_PID"