"""项目路由 — /api/projects

POST   创建项目（仅需标题；集数与小说导入在详情页操作）
GET    项目列表（游标分页）
DELETE 批量删除项目（级联删除全部关联数据 + 清理磁盘小说文件）
"""

from __future__ import annotations

import json
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Project, Script, Character, Scene, Asset, Episode, GenTask, Shot
from app.storage import remove_file

router = APIRouter()


def _project_dict(p: Project, extra: dict | None = None) -> dict:
    d = {
        "id": p.id,
        "title": p.title,
        "status": p.status,
        "style": p.style,
        "novelPath": p.novel_path,
        "novelText": p.novel_text,
        "novelMeta": p.novel_meta,
        "episodeCount": p.episode_count,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "updatedAt": p.updated_at.isoformat() if p.updated_at else None,
    }
    if extra:
        d.update(extra)
    return d


@router.post("")
async def create_project(req: Request, db: AsyncSession = Depends(get_db)):
    body = await req.json()
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "标题不能为空")
    if len(title) > 100:
        raise HTTPException(400, "标题过长")
    episode_count = body.get("episodeCount")
    episode_count = int(episode_count) if episode_count is not None else 6
    if episode_count < 1 or episode_count > 50:
        raise HTTPException(400, "集数必须在 1-50 之间")
    project = Project(title=title, episode_count=episode_count)
    db.add(project)
    await db.flush()
    await db.refresh(project)
    return json.loads(json.dumps(_project_dict(project)))


@router.get("")
async def list_projects(req: Request, db: AsyncSession = Depends(get_db)):
    take = min(100, max(1, int(req.query_params.get("take") or 50)))
    cursor = req.query_params.get("cursor")

    if cursor:
        q = (
            select(Project)
            .where(Project.id < cursor)
            .order_by(Project.id.desc())
            .limit(take)
        )
    else:
        q = select(Project).order_by(Project.updated_at.desc()).limit(take)

    projects = (await db.execute(q)).scalars().all()

    out = []
    for p in projects:
        pid = p.id
        counts = {
            "scripts": (
                await db.execute(
                    select(func.count(Script.id)).where(Script.project_id == pid)
                )
            ).scalar()
            or 0,
            "characters": (
                await db.execute(
                    select(func.count(Character.id)).where(Character.project_id == pid)
                )
            ).scalar()
            or 0,
            "scenes": (
                await db.execute(
                    select(func.count(Scene.id)).where(Scene.project_id == pid)
                )
            ).scalar()
            or 0,
            "episodes": (
                await db.execute(
                    select(func.count(Episode.id)).where(Episode.project_id == pid)
                )
            ).scalar()
            or 0,
        }
        scripts = [
            {
                "id": s.id,
                "approved": s.approved,
                "version": s.version,
                "status": s.status,
                "content": s.content,
            }
            for s in (
                await db.execute(
                    select(Script)
                    .where(Script.project_id == pid)
                    .order_by(Script.version.desc())
                    .limit(50)
                )
            ).scalars()
        ]
        characters = [
            {"id": c.id, "name": c.name, "refImageIds": c.ref_image_ids or []}
            for c in (
                await db.execute(
                    select(Character).where(Character.project_id == pid).limit(50)
                )
            ).scalars()
        ]
        scenes = [
            {"id": s.id, "name": s.name, "refImageIds": s.ref_image_ids or []}
            for s in (
                await db.execute(select(Scene).where(Scene.project_id == pid).limit(50))
            ).scalars()
        ]
        assets = [
            {"id": a.id, "type": a.type}
            for a in (
                await db.execute(select(Asset).where(Asset.project_id == pid).limit(50))
            ).scalars()
        ]
        episodes_rows = (
            (
                await db.execute(
                    select(Episode)
                    .where(Episode.project_id == pid)
                    .order_by(Episode.number.asc())
                )
            )
            .scalars()
            .all()
        )
        episodes = []
        for e in episodes_rows:
            shot_statuses = [
                {"status": s}  # select(Shot.status) 返回的是字符串本身，不是 ORM 对象
                for s in (
                    await db.execute(
                        select(Shot.status)
                        .where(Shot.episode_id == e.id)
                        .order_by(Shot.sequence.asc())
                    )
                ).scalars()
            ]
            episodes.append(
                {
                    "id": e.id,
                    "number": e.number,
                    "status": e.status,
                    "finalPath": e.final_path,
                    "shots": shot_statuses,
                }
            )
        tasks = [
            {"status": t.status, "type": t.type}
            for t in (
                await db.execute(
                    select(GenTask)
                    .where(
                        GenTask.project_id == pid,
                        GenTask.status.in_(
                            ["PROCESSING", "QUEUED", "PAUSED", "FAILED"]
                        ),
                    )
                    .limit(100)
                )
            ).scalars()
        ]
        out.append(
            _project_dict(
                p,
                {
                    "_count": counts,
                    "scripts": scripts,
                    "characters": characters,
                    "scenes": scenes,
                    "assets": assets,
                    "episodes": episodes,
                    "tasks": tasks,
                },
            )
        )
    next_cursor = out[-1]["id"] if len(out) == take else None
    return json.loads(json.dumps({"projects": out, "nextCursor": next_cursor}))


@router.delete("")
async def delete_projects(req: Request, db: AsyncSession = Depends(get_db)):
    body = await req.json()
    ids = body.get("ids") or []
    if not ids or len(ids) > 50:
        raise HTTPException(400, "至少选择一个项目，一次最多删除 50 个")
    targets = (
        await db.execute(
            select(Project.id, Project.novel_path).where(Project.id.in_(ids))
        )
    ).all()
    found_ids = {t[0] for t in targets}
    missing = [i for i in ids if i not in found_ids]
    if missing:
        raise HTTPException(404, f"项目不存在：{', '.join(missing)}")
    await db.execute(delete(Project).where(Project.id.in_(found_ids)))
    for t in targets:
        if t.novel_path:
            remove_file(t.novel_path)
    return {"ok": True, "deleted": len(found_ids)}
