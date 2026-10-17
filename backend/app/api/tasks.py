"""全局任务中心路由 — /api/tasks

GET /api/tasks — 跨项目任务列表（status / projectId / page / pageSize）
POST /api/tasks/{id}/retry — 重试失败/拒绝任务
POST /api/tasks/{id}/resume — 恢复暂停任务
"""

from __future__ import annotations

import json
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import GenTask, Project
from app.pipeline import get_pipeline_paused
from app.retry import retry_gen_task, resume_gen_task

router = APIRouter()

VALID_STATUS = ["QUEUED", "PROCESSING", "DONE", "FAILED", "REJECTED", "PAUSED"]
PAGE_SIZE_DEFAULT = 30


@router.get("/tasks")
async def list_tasks(request: Request, db: AsyncSession = Depends(get_db)):
    status = request.query_params.get("status")
    project_id = request.query_params.get("projectId")
    page = max(1, int(request.query_params.get("page") or 1))
    page_size = min(100, int(request.query_params.get("pageSize") or PAGE_SIZE_DEFAULT))

    where_clauses = []
    if status and status in VALID_STATUS:
        where_clauses.append(GenTask.status == status)
    if project_id:
        where_clauses.append(GenTask.project_id == project_id)

    count_q = select(func.count(GenTask.id))
    task_q = (
        select(GenTask)
        .order_by(GenTask.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    for wc in where_clauses:
        count_q = count_q.where(wc)
        task_q = task_q.where(wc)

    total = (await db.execute(count_q)).scalar() or 0
    tasks = (await db.execute(task_q)).scalars().all()

    # 全局状态计数（不受分页/筛选影响）：驱动前端顶栏统计与「恢复全部暂停」按钮
    status_rows = (
        await db.execute(select(GenTask.status, func.count(GenTask.id)).group_by(GenTask.status))
    ).all()
    status_counts = {row[0]: row[1] for row in status_rows}

    out_tasks = []
    for t in tasks:
        project_title = "—"
        if t.project_id:
            p = (
                await db.execute(
                    select(Project.title).where(Project.id == t.project_id)
                )
            ).scalar_one_or_none()
            project_title = p or "—"
        updated = t.updated_at
        created = t.created_at
        duration_ms = (
            int((updated - created).total_seconds() * 1000)
            if updated and created
            else 0
        )
        out_tasks.append(
            {
                "id": t.id,
                "projectId": t.project_id,
                "projectTitle": project_title,
                "label": t.label,
                "type": t.type,
                "provider": t.provider,
                "model": t.model,
                "status": t.status,
                "cost": t.cost,
                "error": t.error,
                "createdAt": created.isoformat() if created else None,
                "updatedAt": updated.isoformat() if updated else None,
                "durationMs": duration_ms,
            }
        )

    return json.loads(
        json.dumps(
            {
                "total": total,
                "page": page,
                "pageSize": page_size,
                "paused": await get_pipeline_paused(db),
                "statusCounts": status_counts,
                "tasks": out_tasks,
            }
        )
    )


@router.post("/tasks/recover-stuck")
async def recover_stuck():
    """手动触发卡死任务清扫（把超时 QUEUED/PROCESSING 标记 FAILED 以便重试）"""
    from app.queue import recover_stuck_tasks

    n = await recover_stuck_tasks()
    return {"ok": True, "recovered": n}


@router.post("/tasks/{task_id}/retry")
async def retry_task(task_id: str, db: AsyncSession = Depends(get_db)):
    result = await retry_gen_task(db, task_id)
    if not result["ok"]:
        raise HTTPException(400, result.get("error") or "重试失败")
    return {"ok": True, "taskId": task_id}


@router.post("/tasks/{task_id}/resume")
async def resume_task(task_id: str, db: AsyncSession = Depends(get_db)):
    result = await resume_gen_task(db, task_id)
    if not result["ok"]:
        raise HTTPException(400, result.get("error") or "恢复失败")
    return {"ok": True, "taskId": task_id}
