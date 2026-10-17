"""流水线全局控制路由 — /api/pipeline

GET  /api/pipeline — 查询 { paused, queued }
POST /api/pipeline — { action: "pause" | "resume" }
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import GenTask
from app.pipeline import get_pipeline_paused, set_pipeline_paused
from app.retry import resume_all_paused_tasks

router = APIRouter()


@router.get("/pipeline")
async def get_pipeline_status(db: AsyncSession = Depends(get_db)):
    paused = await get_pipeline_paused(db)
    queued = (
        await db.execute(
            select(func.count(GenTask.id)).where(GenTask.status == "QUEUED")
        )
    ).scalar() or 0
    return {"paused": paused, "queued": queued}


@router.post("/pipeline")
async def set_pipeline_action(req: Request, db: AsyncSession = Depends(get_db)):
    try:
        body = await req.json()
    except Exception:
        body = {}
    action = body.get("action")
    if action == "resume_all":
        # 一键把全部 PAUSED 任务重建 payload 重新入队（Worker 重启后继续）
        result = await resume_all_paused_tasks(db)
        queued = (
            await db.execute(
                select(func.count(GenTask.id)).where(GenTask.status == "QUEUED")
            )
        ).scalar() or 0
        return {
            "paused": False,
            "queued": queued,
            "resumed": result.get("resumed", 0),
            "failed": result.get("failed", []),
        }
    if action not in ("pause", "resume"):
        raise HTTPException(400, "action 必须为 pause | resume | resume_all")
    paused = action == "pause"
    await set_pipeline_paused(db, paused)
    queued = (
        await db.execute(
            select(func.count(GenTask.id)).where(GenTask.status == "QUEUED")
        )
    ).scalar() or 0
    return {"paused": paused, "queued": queued}
