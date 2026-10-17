"""调度状态路由 — /api/scheduler

GET  /api/scheduler/status  → 档位、worker 进程组、自动连播开关
POST /api/scheduler/status  → { autoAdvance: bool } 写入 provider_settings
                              （DB > env SCHED_AUTO_ADVANCE > 默认 true，见 app/production.py）
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from app.core.database import get_db
from app.production import _auto_advance_enabled
from app.providers.settings import upsert_setting_async
from app.scheduler.tier import get_status

router = APIRouter()


@router.get("/scheduler/status")
async def get_scheduler_status(db: AsyncSession = Depends(get_db)):
    auto = await _auto_advance_enabled(db)
    return {**get_status(), "autoAdvance": auto}


@router.post("/scheduler/status")
async def set_scheduler_status(req: Request, db: AsyncSession = Depends(get_db)):
    try:
        body = await req.json()
    except Exception:
        body = {}
    if "autoAdvance" in body:
        await upsert_setting_async(
            "sched.autoAdvance", "true" if body.get("autoAdvance") else "false"
        )
    auto = await _auto_advance_enabled(db)
    return {"ok": True, **get_status(), "autoAdvance": auto}
