#!/usr/bin/env bash
#
# 自动化部署脚本 — 打包修复后的代码 + .env.example 模板，部署到测试环境
#
# 用法:
#   ./scripts/deploy.sh              # 仅打包（生成 tarball）
#   ./scripts/deploy.sh user@host    # 打包并部署到指定服务器
#
# 部署目标默认路径: /opt/comic-video（可通过 REMOTE_DIR 环境变量覆盖）
# 部署后需在目标机器执行:
#   cp .env.example .env && 填写真实 Key
#   npm ci --omit=dev
#   npx prisma migrate deploy
#   npm run start
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG_NAME="comic-video"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TARBALL="${PKG_NAME}-${VERSION}-${TIMESTAMP}.tar.gz"
REMOTE_DIR="${REMOTE_DIR:-/opt/comic-video}"

echo "=========================================="
echo "  漫剧视频生成器 — 部署打包"
echo "  版本: $VERSION  时间: $TIMESTAMP"
echo "=========================================="

# ===== 1. 前置检查 =====
echo ""
echo "[1/5] 前置检查..."

if [ ! -f "$PROJECT_DIR/.env.example" ]; then
  echo "  ✗ 缺少 .env.example，请先创建" >&2
  exit 1
fi
echo "  ✓ .env.example 存在"

if [ ! -f "$PROJECT_DIR/prisma/schema.prisma" ]; then
  echo "  ✗ 缺少 prisma/schema.prisma" >&2
  exit 1
fi
echo "  ✓ prisma/schema.prisma 存在"

# ===== 2. 类型检查 =====
echo ""
echo "[2/5] 类型检查 (tsc --noEmit)..."
cd "$PROJECT_DIR"
if ! npx tsc --noEmit 2>&1; then
  echo "  ✗ 类型检查失败，请修复后再部署" >&2
  exit 1
fi
echo "  ✓ 类型检查通过"

# ===== 3. 构建 =====
echo ""
echo "[3/5] 构建 Next.js 生产包..."
if ! npm run build 2>&1; then
  echo "  ✗ 构建失败" >&2
  exit 1
fi
echo "  ✓ 构建成功"

# ===== 4. 打包 =====
echo ""
echo "[4/5] 打包..."

# 打包清单：构建产物 + 运行时必需文件（排除 node_modules / .env / storage / .git）
PACK_LIST=(
  ".next"
  "public"
  "prisma"
  "scripts"
  "src"
  "package.json"
  "package-lock.json"
  "next.config.ts"
  "tsconfig.json"
  "next-env.d.ts"
  ".env.example"
  "vitest.config.ts"
)

# 确保文件存在再加入列表
VALID_LIST=()
for item in "${PACK_LIST[@]}"; do
  if [ -e "$PROJECT_DIR/$item" ]; then
    VALID_LIST+=("$item")
  fi
done

TARBALL_PATH="$PROJECT_DIR/$TARBALL"
tar -czf "$TARBALL_PATH" \
  -C "$PROJECT_DIR" \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='storage' \
  --exclude='.git' \
  --exclude='*.log' \
  "${VALID_LIST[@]}"

TARBALL_SIZE="$(du -h "$TARBALL_PATH" | cut -f1)"
echo "  ✓ 打包完成: $TARBALL ($TARBALL_SIZE)"
echo "  包含: ${VALID_LIST[*]}"

# ===== 5. 部署（可选）=====
REMOTE_TARGET="${1:-}"

if [ -z "$REMOTE_TARGET" ]; then
  echo ""
echo "[5/5] 未指定部署目标，打包文件已生成:"
  echo "  $TARBALL_PATH"
  echo ""
  echo "  手动部署:"
  echo "    scp $TARBALL_PATH user@host:$REMOTE_DIR/"
  echo "    ssh user@host 'cd $REMOTE_DIR && tar xzf $(basename $TARBALL_PATH)'"
  echo "    ssh user@host 'cd $REMOTE_DIR && cp .env.example .env && npm ci --omit=dev && npx prisma migrate deploy && npm run start'"
  exit 0
fi

echo ""
echo "[5/5] 部署到 $REMOTE_TARGET:$REMOTE_DIR ..."

# 上传
echo "  → 上传 tarball..."
scp "$TARBALL_PATH" "$REMOTE_TARGET:/tmp/$TARBALL"

# 远程解压 + 安装 + 启动
echo "  → 远程部署..."
ssh "$REMOTE_TARGET" bash -s <<REMOTE_SCRIPT
set -euo pipefail
REMOTE_DIR="$REMOTE_DIR"
TARBALL="/tmp/$TARBALL"

mkdir -p "\$REMOTE_DIR"
cd "\$REMOTE_DIR"

# 备份当前 .env（如存在）
if [ -f .env ]; then
  cp .env .env.backup.\$(date +%Y%m%d-%H%M%S)
  echo "  → 已备份现有 .env"
fi

# 解压（覆盖）
tar xzf "\$TARBALL"
rm -f "\$TARBALL"

# 安装生产依赖
echo "  → 安装依赖 (npm ci --omit=dev)..."
npm ci --omit=dev

# 数据库迁移
echo "  → 执行数据库迁移..."
npx prisma migrate deploy

# 提示配置环境变量
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ⚠ 已从 .env.example 创建 .env，请编辑填写真实 API Key 后启动"
  echo "    vim .env"
  echo "    npm run start"
else
  echo "  → .env 已存在，请确认配置正确后启动:"
  echo "    npm run start"
fi

echo ""
echo "  ✓ 部署完成！"
REMOTE_SCRIPT

# 清理本地 tarball（可选，保留最近一次）
echo ""
echo "  ✓ 部署成功！tarball 保留在: $TARBALL_PATH"
