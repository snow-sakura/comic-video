"""FastAPI 主应用 — 聚合全部 API 路由 + CORS + 静态素材挂载"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import get_settings
from app.core.redis import init_redis, close_redis
from app.api.projects import router as projects_router
from app.api.projects_detail import router as projects_detail_router
from app.api.tasks import router as tasks_router
from app.api.pipeline import router as pipeline_router
from app.api.settings import router as settings_router
from app.api.prompt_templates import router as prompt_templates_router
from app.api.env import router as env_router
from app.api.files import router as files_router
from app.api.models import router as models_router
from app.api.scheduler import router as scheduler_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.storage_root.mkdir(parents=True, exist_ok=True)
    for d in (
        "novels",
        "characters",
        "scenes",
        "props",
        "shots",
        "clips",
        "videos",
        "audio",
        "subs",
        "bgm",
        "sfx",
        "exports",
        "temp",
    ):
        (settings.storage_root / d).mkdir(exist_ok=True)
    await init_redis()
    # 启动清扫：把历史遗留的 QUEUED/PROCESSING 孤儿任务标记 FAILED，
    # 避免旧任务永久锁死项目闸门（详见 app/queue.recover_stuck_tasks）
    try:
        from app.queue import recover_stuck_tasks

        await recover_stuck_tasks()
    except Exception as e:  # noqa: BLE001 —— 清扫失败不阻塞启动
        print(f"[startup] 卡死任务清扫失败（不阻塞启动）: {e}")
    yield
    await close_redis()


async def _healthz():
    """健康检查：DB + Redis 可达返回 200，任一不可达返回 503"""
    from sqlalchemy import text

    db_ok = redis_ok = False
    try:
        from app.core.database import SessionLocal

        async with SessionLocal() as db:
            await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:  # noqa: BLE001
        detail = f"db: {e}"
    try:
        from app.core.redis import get_redis

        r = await get_redis()
        if r is not None:
            await r.ping()
        redis_ok = True
    except Exception as e:  # noqa: BLE001
        detail = f"redis: {e}"

    if db_ok and redis_ok:
        return {"ok": True, "db": True, "redis": True}
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=503,
        content={"ok": False, "db": db_ok, "redis": redis_ok, "error": detail},
    )


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="AI 漫剧工坊 API", version="0.2.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_api_route("/healthz", _healthz, methods=["GET"], include_in_schema=True)

    app.include_router(projects_router, prefix="/api/projects")
    app.include_router(projects_detail_router, prefix="/api/projects")
    app.include_router(tasks_router, prefix="/api")
    app.include_router(pipeline_router, prefix="/api")
    app.include_router(settings_router, prefix="/api")
    app.include_router(prompt_templates_router, prefix="/api")
    app.include_router(env_router, prefix="/api")
    app.include_router(models_router, prefix="/api")
    app.include_router(scheduler_router, prefix="/api")
    app.include_router(files_router, prefix="/file")

    return app


app = create_app()


if __name__ == "__main__":
    # 模块入口：在 backend/ 下执行 `python -m app.main`（等价于 python run.py）
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000)
