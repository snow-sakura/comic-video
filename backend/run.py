"""AI 漫剧工坊后端 — 独立启动入口

在 backend/ 目录下直接运行：
    python run.py                          # 默认 127.0.0.1:8000
    python run.py --reload                 # 开发模式（代码热重载）
    HOST=0.0.0.0 PORT=8080 python run.py   # 自定义地址
    python run.py --help                   # 查看全部参数

说明：
- 配置读取自 backend/.env（config.py 会自动加载）
- Celery Worker 需单独启动，完整编排请用 ./scripts/start-backend.sh
- 依赖：PostgreSQL（comic_video 库）、Redis（详见 scripts/start-backend.sh 检查逻辑）
"""

from __future__ import annotations

import argparse
import os

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="backend/run.py",
        description="启动 AI 漫剧工坊 FastAPI 后端",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("HOST", "127.0.0.1"),
        help="监听地址（默认 127.0.0.1，可用环境变量 HOST 覆盖）",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("PORT", "8000")),
        help="监听端口（默认 8000，可用环境变量 PORT 覆盖）",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="开发模式：代码变更自动重载（仅本地调试用）",
    )
    args = parser.parse_args()

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
