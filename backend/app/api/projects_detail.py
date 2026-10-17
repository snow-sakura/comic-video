"""项目详情路由 — /api/projects/{id}/**

GET/PATCH/DELETE /projects/{id}            项目详情 / 更新 / 删除
POST/GET      /projects/{id}/novel          上传小说 / 章节元信息
POST/GET      /projects/{id}/script-agent  触发剧本 Agent / 状态聚合
POST/GET/PATCH /projects/{id}/assets       资产出图 / 资产列表 / 一致性锁定
POST/GET/PATCH /projects/{id}/storyboard    分镜车间
PATCH/DELETE   /projects/{id}/shots/{shotId} 编辑 / 删除镜头
POST/GET      /projects/{id}/compose        视频合成厂
GET           /projects/{id}/export?episode=N  整集 ZIP 导出
GET/POST      /projects/{id}/tasks          项目任务 / 批量重试与恢复
"""

from __future__ import annotations

import json
import urllib.parse
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import (
    Project,
    Script,
    Character,
    Scene,
    Asset,
    Episode,
    Shot,
    GenTask,
)
from app.storage import save_file, remove_file
from app.novel import parse_novel
from app.queue import enqueue_gen_task
from app.agents import get_script_stage
from app.assets.prompts import (
    character_design_prompt,
    scene_design_prompt,
    prop_design_prompt,
    style_anchor,
    infer_mood,
)
from app.compose.prompts import build_motion_prompt
from app.providers.settings import get_tts_config
from app.retry import retry_gen_task, resume_gen_task
from app.export import build_episode_export

router = APIRouter()

# 场景同步节流（GET 轮询接口，60s 内只做一次惰性同步）
_scene_sync_throttle: dict[str, float] = {}
SCENE_SYNC_TTL = 60.0


# ========== 序列化辅助 ==========


def _iso(v) -> str | None:
    return v.isoformat() if isinstance(v, datetime) else v


def _project_brief(p: Project) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "status": p.status,
        "style": p.style,
        "novelPath": p.novel_path,
        "novelText": p.novel_text,
        "novelMeta": p.novel_meta,
        "episodeCount": p.episode_count,
        "createdAt": _iso(p.created_at),
        "updatedAt": _iso(p.updated_at),
    }


def _character_dict(c: Character) -> dict:
    return {
        "id": c.id,
        "projectId": c.project_id,
        "name": c.name,
        "role": c.role,
        "gender": c.gender,
        "appearance": c.appearance,
        "personality": c.personality,
        "costume": c.costume,
        "refImageIds": c.ref_image_ids or [],
        "voiceId": c.voice_id,
        "voiceName": c.voice_name,
        "status": c.status,
        "createdAt": _iso(c.created_at),
        "updatedAt": _iso(c.updated_at),
    }


def _scene_dict(s: Scene) -> dict:
    return {
        "id": s.id,
        "projectId": s.project_id,
        "name": s.name,
        "description": s.description,
        "mood": s.mood,
        "refImageIds": s.ref_image_ids or [],
        "status": s.status,
        "createdAt": _iso(s.created_at),
    }


def _asset_dict(a: Asset) -> dict:
    return {
        "id": a.id,
        "projectId": a.project_id,
        "type": a.type,
        "name": a.name,
        "imageIds": a.image_ids or [],
        "meta": a.meta,
        "status": a.status,
        "createdAt": _iso(a.created_at),
    }


def _episode_brief(e: Episode) -> dict:
    return {
        "id": e.id,
        "projectId": e.project_id,
        "number": e.number,
        "title": e.title,
        "hookEnd": e.hook_end,
        "status": e.status,
        "finalPath": e.final_path,
        "createdAt": _iso(e.created_at),
    }


def _task_brief(t: GenTask) -> dict:
    return {
        "id": t.id,
        "label": t.label,
        "type": t.type,
        "provider": t.provider,
        "model": t.model,
        "status": t.status,
        "cost": t.cost,
        "error": t.error,
        "createdAt": _iso(t.created_at),
        "updatedAt": _iso(t.updated_at),
    }


def _shot_dict(s: Shot, full: bool = True) -> dict:
    d = {
        "id": s.id,
        "episodeId": s.episode_id,
        "sequence": s.sequence,
        "sceneName": s.scene_name,
        "camera": s.camera,
        "action": s.action,
        "dialog": s.dialog,
        "dialogChar": s.dialog_char,
        "dialogEmotion": s.dialog_emotion,
        "duration": s.duration,
        "imagePath": s.image_path,
        "videoPath": s.video_path,
        "voicePath": s.voice_path,
        "subtitlePath": s.subtitle_path,
        "status": s.status,
        "error": s.error,
    }
    if full:
        d["prompt7"] = s.prompt7
        d["finalPrompt"] = s.final_prompt
        d["refImages"] = s.ref_images or []
    return d


async def _get_project(db: AsyncSession, project_id: str) -> Project:
    p = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "项目不存在")
    return p


# ========== 项目详情 ==========


@router.get("/{id}")
async def get_project(id: str, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    scripts = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == id)
                .order_by(Script.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    characters = (
        (
            await db.execute(
                select(Character)
                .where(Character.project_id == id)
                .order_by(Character.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    scenes = (
        (
            await db.execute(
                select(Scene)
                .where(Scene.project_id == id)
                .order_by(Scene.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    assets = (
        (
            await db.execute(
                select(Asset)
                .where(Asset.project_id == id)
                .order_by(Asset.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    episodes = (
        (
            await db.execute(
                select(Episode)
                .where(Episode.project_id == id)
                .order_by(Episode.number.asc())
            )
        )
        .scalars()
        .all()
    )
    tasks = (
        (
            await db.execute(
                select(GenTask)
                .where(GenTask.project_id == id)
                .order_by(GenTask.created_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    out = _project_brief(p)
    out["scripts"] = [
        {
            "id": s.id,
            "logline": s.logline,
            "content": s.content,
            "status": s.status,
            "approved": s.approved,
            "version": s.version,
            "createdAt": _iso(s.created_at),
        }
        for s in scripts
    ]
    out["characters"] = [_character_dict(c) for c in characters]
    out["scenes"] = [_scene_dict(s) for s in scenes]
    out["assets"] = [_asset_dict(a) for a in assets]
    out["episodes"] = [_episode_brief(e) for e in episodes]
    out["tasks"] = [_task_brief(t) for t in tasks]
    return json.loads(json.dumps(out, default=str))


@router.patch("/{id}")
async def patch_project(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    try:
        body = await req.json()
    except Exception:
        body = {}
    valid_status = {
        "DRAFT",
        "SCRIPTING",
        "ASSETING",
        "STORYBOARDING",
        "RENDERING",
        "DONE",
    }
    if "title" in body:
        title = (body.get("title") or "").strip()
        if not title:
            raise HTTPException(400, "标题不能为空")
        p.title = title
    if "status" in body:
        if body.get("status") not in valid_status:
            raise HTTPException(400, "status 非法")
        p.status = body["status"]
    if "style" in body and isinstance(body.get("style"), dict):
        p.style = body["style"]
    await db.flush()
    return _project_brief(p)


@router.delete("/{id}")
async def delete_project(id: str, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    if p.novel_path:
        remove_file(p.novel_path)
    await db.execute(delete(Project).where(Project.id == id))
    return {"ok": True}


# ========== 小说上传 ==========


@router.post("/{id}/novel")
async def upload_novel(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    try:
        body = await req.json()
    except Exception:
        body = {}
    text = body.get("text")
    if not text or not str(text).strip():
        raise HTTPException(400, "小说内容为空")
    text = str(text).strip()
    rel = save_file("novels", text, ".txt")
    meta = parse_novel(text)
    if not meta.title and len(text) > 200:
        meta.title = text[:80].split("\n")[0][:40]
    p.novel_path = rel
    p.novel_text = text
    p.novel_meta = {**meta.to_dict(), "stage": "uploaded"}
    p.status = "SCRIPTING"
    await db.flush()
    return {
        "ok": True,
        "chapters": len(meta.chapters),
        "charCount": meta.char_count,
        "wordCount": meta.word_count,
    }


@router.get("/{id}/novel")
async def get_novel(id: str, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    return {"meta": p.novel_meta or None, "hasText": bool(p.novel_text)}


# ========== 剧本工坊 Agent ==========


@router.post("/{id}/script-agent")
async def trigger_script_agent(
    id: str, req: Request, db: AsyncSession = Depends(get_db)
):
    p = await _get_project(db, id)
    if not p.novel_text:
        raise HTTPException(400, "尚未上传小说")
    try:
        body = await req.json()
    except Exception:
        body = {}
    stage = body.get("stage")
    episode_number = int(body["episodeNumber"]) if body.get("episodeNumber") else None
    episode_count = (
        int(round(body["episodeCount"])) if body.get("episodeCount") else None
    )
    if episode_count is not None and not (1 <= episode_count <= 60):
        raise HTTPException(400, "集数必须在 1-60 之间")
    if stage not in ("characters", "outline", "script"):
        raise HTTPException(400, "stage 必须是 characters | outline | script")
    if stage == "script" and not episode_number:
        raise HTTPException(400, "script 阶段需要 episodeNumber")
    if stage == "outline":
        count = (
            await db.execute(
                select(func.count(Character.id)).where(Character.project_id == id)
            )
        ).scalar() or 0
        if count == 0:
            raise HTTPException(400, "请先运行「提炼角色」")
    if stage == "script":
        script = (
            (await db.execute(select(Script).where(Script.project_id == id)))
            .scalars()
            .first()
        )
        content = script.content or {} if script else {}
        if not content.get("episodeOutlines"):
            raise HTTPException(400, "请先运行「生成大纲」")
    # 幂等保护
    running = (
        (
            await db.execute(
                select(GenTask).where(
                    GenTask.project_id == id,
                    GenTask.type == "LLM",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
            )
        )
        .scalars()
        .first()
    )
    if running:
        raise HTTPException(409, "已有剧本任务进行中，请等待完成")

    label_map = {
        "characters": "角色提炼",
        "outline": "分集大纲",
        "script": f"第{episode_number}集剧本",
    }
    task = GenTask(
        project_id=id,
        label=f"剧本工坊·{label_map[stage]}",
        type="LLM",
        provider="script-agent",
        model=stage,
        status="QUEUED",
        input={
            "stage": stage,
            "episodeNumber": episode_number,
            "episodeCount": episode_count,
        },
    )
    db.add(task)
    await db.flush()
    payload: dict = {"agent": stage, "projectId": id}
    if episode_number:
        payload["episodeNumber"] = episode_number
    if episode_count is not None:
        payload["episodeCount"] = episode_count
    enqueue_gen_task("script", task.id, payload)
    return {"ok": True, "taskId": task.id}


@router.get("/{id}/script-agent")
async def script_agent_status(id: str, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    characters = (
        (
            await db.execute(
                select(Character)
                .where(Character.project_id == id)
                .order_by(Character.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    script = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == id)
                .order_by(Script.version.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    episodes = (
        (
            await db.execute(
                select(Episode)
                .where(Episode.project_id == id)
                .order_by(Episode.number.asc())
            )
        )
        .scalars()
        .all()
    )
    running = (
        (
            await db.execute(
                select(GenTask)
                .where(
                    GenTask.project_id == id,
                    GenTask.type == "LLM",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
                .order_by(GenTask.created_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    content = script.content or {} if script else {}
    ep_content = content.get("episodes") or []
    generated = sum(
        1
        for e in ep_content
        if isinstance(e, dict) and isinstance(e.get("scenes"), list) and e["scenes"]
    )
    episode_scripts = {
        str(e["number"]): e
        for e in ep_content
        if isinstance(e, dict)
        and isinstance(e.get("number"), int)
        and isinstance(e.get("scenes"), list)
        and e["scenes"]
    }
    return json.loads(
        json.dumps(
            {
                "stage": await get_script_stage(db, id),
                "hasNovel": bool(p.novel_text),
                "episodeCount": p.episode_count or 6,
                "chapters": (p.novel_meta or {}).get("chapters", [])
                and len(p.novel_meta["chapters"])
                or 0,
                "characters": [_character_dict(c) for c in characters],
                "logline": script.logline if script else None,
                "worldView": content.get("worldView"),
                "generatedEpisodes": generated,
                "episodeScripts": episode_scripts,
                "episodes": [_episode_brief(e) for e in episodes],
                "runningTask": _task_brief(running) if running else None,
            },
            default=str,
        )
    )


# ========== 资产工厂 ==========


async def _sync_scenes(db: AsyncSession, project_id: str) -> None:
    """场景惰性同步：从剧本提取场景写入 Scene 表（60s 节流）"""
    import time

    now = time.time()
    if now - _scene_sync_throttle.get(project_id, 0) < SCENE_SYNC_TTL:
        return
    _scene_sync_throttle[project_id] = now
    script = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == project_id)
                .order_by(Script.version.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if not script:
        return
    content = script.content or {}
    seen: set[str] = set()
    inputs: list[dict] = []
    for ep in content.get("episodes", []):
        if not isinstance(ep, dict):
            continue
        for s in ep.get("scenes", []):
            if not isinstance(s, dict):
                continue
            name = (s.get("location") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            time_str = s.get("time") or ""
            action_str = s.get("action") or ""
            inputs.append(
                {
                    "name": name,
                    "description": action_str[:200] if action_str else None,
                    "mood": infer_mood(f"{time_str} {action_str}"),
                }
            )
    existing = (
        (await db.execute(select(Scene.name).where(Scene.project_id == project_id)))
        .scalars()
        .all()
    )
    exist_names = set(existing)
    for s in inputs:
        if s["name"] in exist_names:
            continue
        db.add(Scene(project_id=project_id, **s, status="DRAFTING"))
    await db.flush()


@router.post("/{id}/assets")
async def generate_assets(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    try:
        body = await req.json()
    except Exception:
        body = {}
    kind = body.get("kind")
    ref_id = str(body["refId"]) if body.get("refId") else None
    regenerate = body.get("regenerate") is True
    if kind not in ("character", "scene", "prop", "voice"):
        raise HTTPException(400, "kind 必须是 character | scene | prop | voice")

    # 音色智能化：描述 → 匹配最接近音色
    if kind == "voice":
        from app.agents import match_voice_id

        if ref_id:
            chars = [
                (
                    await db.execute(
                        select(Character).where(
                            Character.id == ref_id, Character.project_id == id
                        )
                    )
                )
                .scalars()
                .first()
            ]
        else:
            chars = (
                (
                    await db.execute(
                        select(Character)
                        .where(Character.project_id == id)
                        .order_by(Character.created_at.asc())
                    )
                )
                .scalars()
                .all()
            )
        targets = [c for c in chars if c]
        if not targets:
            raise HTTPException(404, "暂无角色")
        updated = []
        for c in targets:
            gender = c.gender or (
                "male"
                if "男" in (c.voice_name or "")
                else "female"
                if "女" in (c.voice_name or "")
                else None
            )
            voice_id = match_voice_id(c.voice_name, gender)
            c.voice_id = voice_id
            updated.append(
                {
                    "id": c.id,
                    "name": c.name,
                    "voiceId": voice_id,
                    "voiceName": c.voice_name,
                }
            )
        await db.flush()
        return {"ok": True, "updated": updated, "kind": "voice"}

    # 运行中任务保护
    running = (
        (
            await db.execute(
                select(GenTask).where(
                    GenTask.project_id == id,
                    GenTask.type == "IMAGE",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
            )
        )
        .scalars()
        .first()
    )
    if running:
        raise HTTPException(409, "已有图像任务进行中")

    anchor = style_anchor(p.style)

    # 角色定妆照：支持批量 + 三角度独立任务
    if kind == "character":
        if ref_id:
            chars = [
                (
                    await db.execute(
                        select(Character).where(
                            Character.id == ref_id, Character.project_id == id
                        )
                    )
                )
                .scalars()
                .all()
            ]
        else:
            chars = (
                (
                    await db.execute(
                        select(Character)
                        .where(Character.project_id == id)
                        .order_by(Character.created_at.asc())
                    )
                )
                .scalars()
                .all()
            )
        targets = [c for c in chars if c]
        if not targets:
            raise HTTPException(404, "角色不存在")
        enqueued = []
        for character in targets:
            c = character.appearance or {}
            input_ = {
                "name": character.name,
                "role": character.role,
                "gender": character.gender,
                "appearance": {
                    "hair": c.get("hair", "待定"),
                    "costume": c.get("costume", "待定"),
                    "facialMarkers": c.get("facialMarkers", "待定"),
                    "body": c.get("body", "待定"),
                    "style": c.get("style", "待定"),
                },
                "refImageIds": character.ref_image_ids or [],
            }
            locked = (
                not regenerate
                and len(character.ref_image_ids or []) > 0
                and character.status == "APPROVED"
            )
            angles = (
                [{"angle": "three-quarter", "label": "侧面补全"}]
                if locked
                else [
                    {"angle": "front", "label": "正面"},
                    {"angle": "three-quarter", "label": "侧面"},
                    {"angle": "full", "label": "全身"},
                ]
            )
            for a in angles:
                prompt = await character_design_prompt(input_, anchor, a["angle"], id)
                task = GenTask(
                    project_id=id,
                    label=f"角色定妆照·{character.name}·{a['label']}",
                    type="IMAGE",
                    provider="agnes",
                    model="agnes-image-2.5-flash",
                    ref_type="character",
                    ref_id=character.id,
                    status="QUEUED",
                    input={
                        "kind": kind,
                        "angle": a["angle"],
                        "prompt": prompt[:500],
                        "refImages": len(character.ref_image_ids or []),
                    },
                )
                db.add(task)
                await db.flush()
                enqueue_gen_task(
                    "image",
                    task.id,
                    {
                        "prompt": prompt,
                        "refImages": character.ref_image_ids if locked else [],
                        "count": 1,
                        "aspectRatio": "3:4",
                        "refType": "character",
                        "refId": character.id,
                        "category": "characters",
                    },
                )
                enqueued.append(
                    {
                        "characterId": character.id,
                        "taskId": task.id,
                        "angle": a["angle"],
                    }
                )
        return {
            "ok": True,
            "enqueued": len(enqueued),
            "tasks": enqueued,
            "kind": kind,
            "refId": ref_id,
        }

    # 场景空镜：支持批量
    if kind == "scene" and not ref_id:
        scenes = (
            (
                await db.execute(
                    select(Scene)
                    .where(Scene.project_id == id)
                    .order_by(Scene.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        if not scenes:
            raise HTTPException(404, "暂无场景，请先生成剧本")
        enqueued = []
        for scene in scenes:
            prompt = await scene_design_prompt(
                {
                    "name": scene.name,
                    "description": scene.description,
                    "mood": scene.mood,
                    "refImageIds": scene.ref_image_ids or [],
                },
                anchor,
                id,
            )
            task = GenTask(
                project_id=id,
                label=f"场景空镜·{scene.name}",
                type="IMAGE",
                provider="agnes",
                model="agnes-image-2.5-flash",
                ref_type="scene",
                ref_id=scene.id,
                status="QUEUED",
                input={
                    "kind": kind,
                    "prompt": prompt[:500],
                    "refImages": len(scene.ref_image_ids or []),
                },
            )
            db.add(task)
            await db.flush()
            enqueue_gen_task(
                "image",
                task.id,
                {
                    "prompt": prompt,
                    "refImages": scene.ref_image_ids or [],
                    "count": 1,
                    "aspectRatio": "16:9",
                    "refType": "scene",
                    "refId": scene.id,
                    "category": "scenes",
                },
            )
            enqueued.append({"sceneId": scene.id, "taskId": task.id})
        return {
            "ok": True,
            "enqueued": len(enqueued),
            "tasks": enqueued,
            "kind": kind,
            "refId": ref_id,
        }

    # 场景 / 道具：单任务
    if kind == "scene":
        scene = None
        if ref_id:
            scene = (
                (
                    await db.execute(
                        select(Scene).where(Scene.id == ref_id, Scene.project_id == id)
                    )
                )
                .scalars()
                .first()
            )
        if not scene:
            raise HTTPException(404, "场景不存在")
        prompt = await scene_design_prompt(
            {
                "name": scene.name,
                "description": scene.description,
                "mood": scene.mood,
                "refImageIds": scene.ref_image_ids or [],
            },
            anchor,
            id,
        )
        ref_images = scene.ref_image_ids or []
        label = f"场景空镜·{scene.name}"
        ref_type, ref_target = "scene", scene.id
    else:  # prop
        name = str(body.get("name") or "未命名道具")
        desc = str(body.get("desc") or "")
        asset = None
        if ref_id:
            asset = (
                (
                    await db.execute(
                        select(Asset).where(
                            Asset.id == ref_id,
                            Asset.project_id == id,
                            Asset.type == "PROP",
                        )
                    )
                )
                .scalars()
                .first()
            )
        if not asset:
            asset = Asset(
                project_id=id,
                type="PROP",
                name=name,
                meta={"desc": desc},
                status="DRAFTING",
            )
            db.add(asset)
            await db.flush()
        prompt = await prop_design_prompt(asset.name, desc, anchor, id)
        ref_images = asset.image_ids or []
        label = f"道具设计·{asset.name}"
        ref_type, ref_target = "asset", asset.id

    task = GenTask(
        project_id=id,
        label=label,
        type="IMAGE",
        provider="agnes",
        model="agnes-image-2.5-flash",
        ref_type=ref_type,
        ref_id=ref_target,
        status="QUEUED",
        input={"kind": kind, "prompt": prompt[:500], "refImages": len(ref_images)},
    )
    db.add(task)
    await db.flush()
    category = {"character": "characters", "scene": "scenes", "prop": "props"}.get(
        kind, "scenes"
    )
    enqueue_gen_task(
        "image",
        task.id,
        {
            "prompt": prompt,
            "refImages": ref_images,
            "count": 1,
            "aspectRatio": "3:4" if kind == "character" else "16:9",
            "refType": ref_type,
            "refId": ref_target,
            "category": category,
        },
    )
    return {"ok": True, "taskId": task.id, "kind": kind, "refId": ref_id}


@router.get("/{id}/assets")
async def list_assets(id: str, db: AsyncSession = Depends(get_db)):
    await _get_project(db, id)
    await _sync_scenes(db, id)
    characters = (
        (
            await db.execute(
                select(Character)
                .where(Character.project_id == id)
                .order_by(Character.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    scenes = (
        (
            await db.execute(
                select(Scene)
                .where(Scene.project_id == id)
                .order_by(Scene.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    props = (
        (
            await db.execute(
                select(Asset)
                .where(Asset.project_id == id, Asset.type == "PROP")
                .order_by(Asset.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    running = (
        (
            await db.execute(
                select(GenTask)
                .where(
                    GenTask.project_id == id,
                    GenTask.type == "IMAGE",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
                .order_by(GenTask.created_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    return json.loads(
        json.dumps(
            {
                "characters": [_character_dict(c) for c in characters],
                "scenes": [_scene_dict(s) for s in scenes],
                "props": [_asset_dict(a) for a in props],
                "runningTask": _task_brief(running) if running else None,
            },
            default=str,
        )
    )


@router.patch("/{id}/assets")
async def patch_asset(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    body = {}
    try:
        body = await req.json()
    except Exception:
        pass
    kind = body.get("kind")
    ref_id = str(body["refId"]) if body.get("refId") else None
    status = body.get("status")
    # 音色手动指定
    if kind == "voice" and ref_id and body.get("voiceId"):
        voice_id = str(body["voiceId"])
        res = await db.execute(
            update(Character)
            .where(Character.id == ref_id, Character.project_id == id)
            .values(voice_id=voice_id)
        )
        if res.rowcount == 0:
            raise HTTPException(404, "角色不存在")
        await db.flush()
        return {"ok": True, "voiceId": voice_id}
    if (
        kind not in ("character", "scene", "prop")
        or not ref_id
        or status not in ("APPROVED", "REJECTED", "DRAFTING")
    ):
        raise HTTPException(400, "参数不完整")
    model = {"character": Character, "scene": Scene, "prop": Asset}[kind]
    await db.execute(
        update(model)
        .where(model.id == ref_id, model.project_id == id)
        .values(status=status)
    )
    await db.flush()
    return {"ok": True}


# ========== 分镜车间 ==========


@router.post("/{id}/storyboard")
async def storyboard_action(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    try:
        body = await req.json()
    except Exception:
        body = {}
    stage = body.get("stage")
    episode_number = int(body["episodeNumber"]) if body.get("episodeNumber") else None
    shot_id = body.get("shotId")
    shots_in = body.get("shots")
    if not episode_number:
        raise HTTPException(400, "需要 episodeNumber")
    episode = (
        (
            await db.execute(
                select(Episode).where(
                    Episode.project_id == id, Episode.number == episode_number
                )
            )
        )
        .scalars()
        .first()
    )
    if not episode:
        raise HTTPException(404, "该集不存在，请先完成剧本")

    from app.storyboard import assemble_shot_prompts

    if stage == "manual":
        items = shots_in or []
        if not items:
            raise HTTPException(400, "shots 不能为空")
        max_seq = (
            await db.execute(
                select(func.max(Shot.sequence)).where(Shot.episode_id == episode.id)
            )
        ).scalar() or 0
        seq = max_seq + 1
        created = 0
        for it in items:
            action = (it.get("action") or "").strip()
            dialog = (it.get("dialog") or "").strip()
            if not action and not dialog:
                continue
            db.add(
                Shot(
                    episode_id=episode.id,
                    sequence=seq,
                    scene_name=(it.get("sceneName") or "").strip() or None,
                    camera={"angle": "平视", "movement": "固定", "shotSize": "中景"},
                    action=action or None,
                    dialog=dialog or None,
                    dialog_char=(it.get("dialogChar") or "").strip() or None,
                    dialog_emotion=(it.get("dialogEmotion") or "").strip() or None,
                    duration=float(it.get("duration") or 5) or 5.0,
                    status="PENDING",
                )
            )
            seq += 1
            created += 1
        if created == 0:
            raise HTTPException(400, "没有有效镜头（至少填动作或台词）")
        await db.flush()
        await assemble_shot_prompts(db, id, episode.id)
        return {"ok": True, "created": created}

    if stage == "storyboard":
        running = (
            (
                await db.execute(
                    select(GenTask).where(
                        GenTask.project_id == id,
                        GenTask.type == "LLM",
                        GenTask.status.in_(["QUEUED", "PROCESSING"]),
                    )
                )
            )
            .scalars()
            .first()
        )
        if running:
            raise HTTPException(409, "已有任务进行中")
        task = GenTask(
            project_id=id,
            label=f"分镜·第{episode_number}集",
            type="LLM",
            provider="script-agent",
            model="storyboard",
            status="QUEUED",
            input={"stage": stage, "episodeNumber": episode_number},
        )
        db.add(task)
        await db.flush()
        enqueue_gen_task(
            "script",
            task.id,
            {"agent": "storyboard", "projectId": id, "episodeNumber": episode_number},
        )
        return {"ok": True, "taskId": task.id}

    if stage == "images":
        if shot_id:
            targets = (
                (
                    await db.execute(
                        select(Shot).where(
                            Shot.id == shot_id, Shot.episode_id == episode.id
                        )
                    )
                )
                .scalars()
                .all()
            )
        else:
            targets = (
                (
                    await db.execute(
                        select(Shot)
                        .where(Shot.episode_id == episode.id)
                        .order_by(Shot.sequence.asc())
                    )
                )
                .scalars()
                .all()
            )
        if not targets:
            raise HTTPException(400, "该集暂无镜头，请先执行分镜")
        ready = [
            s for s in targets if s.final_prompt and s.status != "IMAGE_GENERATING"
        ]
        if not ready:
            raise HTTPException(400, "目标镜头均无提示词或正在生成")
        running_count = (
            await db.execute(
                select(func.count(GenTask.id)).where(
                    GenTask.project_id == id,
                    GenTask.type == "IMAGE",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
            )
        ).scalar() or 0
        if running_count > 0 and not shot_id:
            raise HTTPException(409, "已有图像任务进行中")
        enqueued = []
        for shot in ready:
            task = GenTask(
                project_id=id,
                label=f"分镜图·第{episode_number}集#{shot.sequence}",
                type="IMAGE",
                provider="agnes",
                model="agnes-image-2.5-flash",
                ref_type="shot",
                ref_id=shot.id,
                status="QUEUED",
                input={"shotId": shot.id, "episodeNumber": episode_number},
            )
            db.add(task)
            await db.flush()
            await db.execute(
                update(Shot).where(Shot.id == shot.id).values(status="IMAGE_GENERATING")
            )
            enqueue_gen_task(
                "image",
                task.id,
                {
                    "prompt": shot.final_prompt,
                    "refImages": shot.ref_images or [],
                    "count": 1,
                    "aspectRatio": "16:9",
                    "shotId": shot.id,
                    "category": "shots",
                },
            )
            enqueued.append(shot.id)
        return {"ok": True, "enqueued": len(enqueued), "shotIds": enqueued}

    raise HTTPException(400, "stage 必须是 storyboard | images | manual")


@router.get("/{id}/storyboard")
async def storyboard_list(id: str, db: AsyncSession = Depends(get_db)):
    await _get_project(db, id)
    episodes = (
        (
            await db.execute(
                select(Episode)
                .where(Episode.project_id == id)
                .order_by(Episode.number.asc())
            )
        )
        .scalars()
        .all()
    )
    out_eps = []
    for e in episodes:
        shots = (
            (
                await db.execute(
                    select(Shot)
                    .where(Shot.episode_id == e.id)
                    .order_by(Shot.sequence.asc())
                )
            )
            .scalars()
            .all()
        )
        out_eps.append(
            {
                "id": e.id,
                "number": e.number,
                "title": e.title,
                "status": e.status,
                "shots": [_shot_dict(s) for s in shots],
            }
        )
    running = (
        (
            await db.execute(
                select(GenTask)
                .where(
                    GenTask.project_id == id,
                    GenTask.type.in_(["LLM", "IMAGE"]),
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
                .order_by(GenTask.created_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    return json.loads(
        json.dumps(
            {
                "episodes": out_eps,
                "runningTask": _task_brief(running) if running else None,
            },
            default=str,
        )
    )


@router.patch("/{id}/storyboard")
async def storyboard_reject(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    try:
        body = await req.json()
    except Exception:
        body = {}
    shot_id = body.get("shotId")
    status = body.get("status")
    if not shot_id or status != "REJECTED":
        raise HTTPException(400, "参数不完整")
    shot = (await db.execute(select(Shot).where(Shot.id == shot_id))).scalars().first()
    if not shot:
        raise HTTPException(404, "镜头不存在")
    await db.execute(
        update(Shot).where(Shot.id == shot_id).values(status="REJECTED", error=None)
    )
    await db.flush()
    return {"ok": True}


# ========== 镜头编辑 / 删除 ==========


@router.patch("/{id}/shots/{shot_id}")
async def patch_shot(
    id: str, shot_id: str, req: Request, db: AsyncSession = Depends(get_db)
):
    await _get_project(db, id)
    shot = (
        (
            await db.execute(
                select(Shot)
                .where(Shot.id == shot_id)
                .join(Episode, Shot.episode_id == Episode.id)
                .where(Episode.project_id == id)
            )
        )
        .scalars()
        .first()
    )
    if not shot:
        raise HTTPException(404, "镜头不存在")
    try:
        body = await req.json()
    except Exception:
        body = {}

    def _s(v):
        return v.strip() if isinstance(v, str) else None

    dialog = _s(body.get("dialog")) if "dialog" in body else None
    dialog_char = _s(body.get("dialogChar")) if "dialogChar" in body else None
    dialog_emotion = _s(body.get("dialogEmotion")) if "dialogEmotion" in body else None
    scene_name = _s(body.get("sceneName")) if "sceneName" in body else None
    action = _s(body.get("action")) if "action" in body else None
    duration = (
        body.get("duration") if isinstance(body.get("duration"), (int, float)) else None
    )
    camera = body.get("camera") if isinstance(body.get("camera"), dict) else None
    if not any(
        v is not None
        for v in (
            dialog,
            dialog_char,
            dialog_emotion,
            scene_name,
            action,
            duration,
            camera,
        )
    ):
        raise HTTPException(400, "至少提供一个字段")

    voiced_changed = (
        (dialog is not None and dialog != shot.dialog)
        or (dialog_char is not None and dialog_char != shot.dialog_char)
        or (dialog_emotion is not None and dialog_emotion != shot.dialog_emotion)
    )
    visual_changed = (
        (scene_name is not None and scene_name != shot.scene_name)
        or (action is not None and action != shot.action)
        or (
            camera is not None
            and json.dumps(camera, sort_keys=True)
            != json.dumps(shot.camera or {}, sort_keys=True)
        )
    )
    was_voiced = (
        bool(shot.voice_path)
        or bool(shot.subtitle_path)
        or shot.status.startswith("VOICE")
    )
    has_visual_product = (
        bool(shot.image_path)
        or bool(shot.video_path)
        or shot.status.startswith("IMAGE")
    )

    values: dict = {}
    if dialog is not None:
        values["dialog"] = dialog or None
    if dialog_char is not None:
        values["dialog_char"] = dialog_char or None
    if dialog_emotion is not None:
        values["dialog_emotion"] = dialog_emotion or None
    if scene_name is not None:
        values["scene_name"] = scene_name or None
    if action is not None:
        values["action"] = action or None
    if duration is not None and duration > 0:
        values["duration"] = duration
    if camera:
        values["camera"] = camera
    if voiced_changed and was_voiced:
        values.update(
            {
                "voice_path": None,
                "subtitle_path": None,
                "status": "VIDEO_DONE" if shot.video_path else "IMAGE_DONE",
            }
        )
    if visual_changed and has_visual_product:
        values.update(
            {
                "image_path": None,
                "video_path": None,
                "voice_path": None,
                "subtitle_path": None,
                "status": "PROMPT_READY",
            }
        )
    await db.execute(update(Shot).where(Shot.id == shot_id).values(**values))
    await db.flush()

    if visual_changed:
        from app.storyboard import assemble_shot_prompts

        await assemble_shot_prompts(db, id, shot.episode_id)

    shot = (await db.execute(select(Shot).where(Shot.id == shot_id))).scalars().first()
    return {"ok": True, "shot": {"id": shot.id, "status": shot.status}}


@router.delete("/{id}/shots/{shot_id}")
async def delete_shot(id: str, shot_id: str, db: AsyncSession = Depends(get_db)):
    await _get_project(db, id)
    shot = (
        (
            await db.execute(
                select(Shot)
                .where(Shot.id == shot_id)
                .join(Episode, Shot.episode_id == Episode.id)
                .where(Episode.project_id == id)
            )
        )
        .scalars()
        .first()
    )
    if not shot:
        raise HTTPException(404, "镜头不存在")
    for p in (shot.image_path, shot.video_path, shot.voice_path):
        if p:
            remove_file(p)
    await db.execute(delete(Shot).where(Shot.id == shot_id))
    await db.flush()
    return {"ok": True}


# ========== 视频合成厂 ==========


@router.post("/{id}/compose")
async def compose_action(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    try:
        body = await req.json()
    except Exception:
        body = {}
    stage = body.get("stage")
    episode_number = int(body["episodeNumber"]) if body.get("episodeNumber") else None
    shot_id = body.get("shotId")
    bgm_mood = body.get("bgmMood")
    if stage not in ("video", "voice", "compose") or not episode_number:
        raise HTTPException(400, "stage 必须是 video | voice | compose")

    # 视频闸门（D3/D5）：前面的集未完成视频生成时，禁止先启动后面的集；
    # 单镜头重试（shotId）或显式 force 直通（管理/重试入口）
    if stage == "video" and not shot_id and not body.get("force"):
        from app.production import first_blocking_episode

        blocked = await first_blocking_episode(db, id, episode_number)
        if blocked:
            raise HTTPException(
                409,
                {
                    "error": blocked["reason"],
                    "blockedBy": blocked["blockedBy"],
                    "missing": blocked["missing"],
                    "failed": blocked["failed"],
                },
            )
    episode = (
        (
            await db.execute(
                select(Episode).where(
                    Episode.project_id == id, Episode.number == episode_number
                )
            )
        )
        .scalars()
        .first()
    )
    if not episode:
        raise HTTPException(404, "该集不存在，请先完成剧本")

    if shot_id:
        targets = (
            (
                await db.execute(
                    select(Shot).where(
                        Shot.id == shot_id, Shot.episode_id == episode.id
                    )
                )
            )
            .scalars()
            .all()
        )
    else:
        targets = (
            (
                await db.execute(
                    select(Shot)
                    .where(Shot.episode_id == episode.id)
                    .order_by(Shot.sequence.asc())
                )
            )
            .scalars()
            .all()
        )

    if stage == "video":
        if not targets:
            raise HTTPException(400, "该集暂无镜头，请先完成分镜")
        ready = [
            s
            for s in targets
            if s.image_path and s.status not in ("VIDEO_GENERATING", "VIDEO_DONE")
        ]
        if not ready:
            raise HTTPException(400, "目标镜头均无分镜图或正在生成视频")
        running = (
            await db.execute(
                select(func.count(GenTask.id)).where(
                    GenTask.project_id == id,
                    GenTask.type == "VIDEO",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
            )
        ).scalar() or 0
        if running > 0 and not shot_id:
            raise HTTPException(409, "已有视频任务进行中")
        enqueued = []
        for shot in ready:
            task = GenTask(
                project_id=id,
                label=f"视频·第{episode_number}集#{shot.sequence}",
                type="VIDEO",
                provider="agnes",
                model="agnes-video-2.5-flash",
                ref_type="shot",
                ref_id=shot.id,
                status="QUEUED",
                input={"shotId": shot.id, "episodeNumber": episode_number},
            )
            db.add(task)
            await db.flush()
            await db.execute(
                update(Shot).where(Shot.id == shot.id).values(status="VIDEO_GENERATING")
            )
            shot_dict = {
                "sceneName": shot.scene_name,
                "camera": shot.camera or {},
                "action": shot.action,
                "dialog": shot.dialog,
                "dialogChar": shot.dialog_char,
                "dialogEmotion": shot.dialog_emotion,
                "duration": shot.duration,
            }
            enqueue_gen_task(
                "video",
                task.id,
                {
                    "shotId": shot.id,
                    "imagePath": shot.image_path,
                    "prompt": await build_motion_prompt(shot_dict, id),
                    "duration": 5,
                },
            )
            enqueued.append(shot.id)
        return {"ok": True, "enqueued": len(enqueued), "shotIds": enqueued}

    if stage == "voice":
        if not targets:
            raise HTTPException(400, "该集暂无镜头，请先完成分镜")
        ready = [
            s
            for s in targets
            if s.dialog
            and s.status != "VOICE_GENERATING"
            and (s.video_path or s.image_path)
        ]
        if not ready:
            raise HTTPException(400, "目标镜头均无台词或正在配音")
        running = (
            await db.execute(
                select(func.count(GenTask.id)).where(
                    GenTask.project_id == id,
                    GenTask.type == "TTS",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
            )
        ).scalar() or 0
        if running > 0 and not shot_id:
            raise HTTPException(409, "已有配音任务进行中")
        chars = (
            (await db.execute(select(Character).where(Character.project_id == id)))
            .scalars()
            .all()
        )
        voice_by_char = {c.name: (c.voice_id or c.voice_name) for c in chars}
        tts_cfg = get_tts_config()
        tts_provider = tts_cfg.get("engine") or "mock"
        enqueued = []
        for shot in ready:
            task = GenTask(
                project_id=id,
                label=f"配音·第{episode_number}集#{shot.sequence}"
                + (f"·{shot.dialog_char}" if shot.dialog_char else ""),
                type="TTS",
                provider=tts_provider,
                model=tts_cfg.get("model") or "tts",
                ref_type="shot",
                ref_id=shot.id,
                status="QUEUED",
                input={"shotId": shot.id, "episodeNumber": episode_number},
            )
            db.add(task)
            await db.flush()
            await db.execute(
                update(Shot).where(Shot.id == shot.id).values(status="VOICE_GENERATING")
            )
            enqueue_gen_task(
                "audio",
                task.id,
                {
                    "shotId": shot.id,
                    "text": shot.dialog,
                    "voiceId": voice_by_char.get(shot.dialog_char)
                    if shot.dialog_char
                    else None,
                    "emotion": shot.dialog_emotion,
                },
            )
            enqueued.append(shot.id)
        return {"ok": True, "enqueued": len(enqueued), "shotIds": enqueued}

    # compose
    if not targets:
        raise HTTPException(400, "该集暂无镜头")
    with_video = [s for s in targets if s.video_path]
    if not with_video:
        raise HTTPException(400, "该集还没有视频片段，请先生成视频")
    running = (
        (
            await db.execute(
                select(GenTask).where(
                    GenTask.project_id == id,
                    GenTask.type == "COMPOSE",
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
            )
        )
        .scalars()
        .first()
    )
    if running:
        raise HTTPException(409, "已有合成任务进行中")
    task = GenTask(
        project_id=id,
        label=f"合成·第{episode_number}集",
        type="COMPOSE",
        provider="ffmpeg",
        model="compose",
        status="QUEUED",
        input={"episodeId": episode.id, "bgmMood": bgm_mood},
    )
    db.add(task)
    await db.flush()
    await db.execute(
        update(Episode).where(Episode.id == episode.id).values(status="composing")
    )
    enqueue_gen_task("compose", task.id, {"episodeId": episode.id, "bgmMood": bgm_mood})
    return {"ok": True, "taskId": task.id}


@router.get("/{id}/compose")
async def compose_list(id: str, db: AsyncSession = Depends(get_db)):
    await _get_project(db, id)
    episodes = (
        (
            await db.execute(
                select(Episode)
                .where(Episode.project_id == id)
                .order_by(Episode.number.asc())
            )
        )
        .scalars()
        .all()
    )
    out_eps = []
    for e in episodes:
        shots = (
            (
                await db.execute(
                    select(Shot)
                    .where(Shot.episode_id == e.id)
                    .order_by(Shot.sequence.asc())
                )
            )
            .scalars()
            .all()
        )
        out_eps.append(
            {
                "id": e.id,
                "number": e.number,
                "title": e.title,
                "status": e.status,
                "finalPath": e.final_path,
                "shots": [_shot_dict(s, full=False) for s in shots],
            }
        )
    running = (
        (
            await db.execute(
                select(GenTask)
                .where(
                    GenTask.project_id == id,
                    GenTask.type.in_(["VIDEO", "TTS", "COMPOSE"]),
                    GenTask.status.in_(["QUEUED", "PROCESSING"]),
                )
                .order_by(GenTask.created_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    return json.loads(
        json.dumps(
            {
                "episodes": out_eps,
                "runningTask": _task_brief(running) if running else None,
            },
            default=str,
        )
    )


# ========== 逐集串行自动生产 ==========


@router.post("/{id}/produce")
async def produce_action(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    """启动/继续逐集串行生产。

    body: { episodeNumber?: int }  — 指定从某集开始；缺省自动找第一个未完结集。
    规则：同一时刻只有一集在生产；该集 图→视频→配音→合成 全部完成后
    自动进入下一集；任一集失败则停住（重试失败镜头后再次调用继续）。
    """
    from app.production import advance_project, resume_episode_chain, skip_failed_shots

    await _get_project(db, id)
    try:
        body = await req.json()
    except Exception:
        body = {}
    episode_number = int(body["episodeNumber"]) if body.get("episodeNumber") else None

    # D5：显式跳过失败镜头后，其不参与生产/闸门判定
    if body.get("skipFailed"):
        n = await skip_failed_shots(db, id, episode_number)

    if episode_number:
        episode = (
            (
                await db.execute(
                    select(Episode).where(
                        Episode.project_id == id, Episode.number == episode_number
                    )
                )
            )
            .scalars()
            .first()
        )
        if not episode:
            raise HTTPException(404, "该集不存在，请先完成剧本")
        stage = await resume_episode_chain(db, id, episode)
        await db.commit()
        return {
            "ok": True,
            "started": bool(stage),
            "episodeNumber": episode_number,
            "stage": stage,
        }

    result = await advance_project(db, id)
    await db.commit()
    return {"ok": True, **result}


# ========== 整集 ZIP 导出 ==========


@router.get("/{id}/export")
async def export_episode(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    p = await _get_project(db, id)
    episode_number = int(req.query_params.get("episode") or 1)
    episode = (
        (
            await db.execute(
                select(Episode).where(
                    Episode.project_id == id, Episode.number == episode_number
                )
            )
        )
        .scalars()
        .first()
    )
    if not episode:
        raise HTTPException(404, "剧集不存在")
    try:
        zip_rel = await build_episode_export(db, id, episode_number)
    except ValueError as e:
        raise HTTPException(404, str(e))
    from app.storage import abs_path

    data = abs_path(zip_rel).read_bytes()
    ascii_name = f"{p.title}-ep{episode_number}-export.zip".encode(
        "ascii", "ignore"
    ).decode()
    utf8_name = urllib.parse.quote(f"{p.title}-ep{episode_number}-export.zip")
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}",
            "Cache-Control": "no-store",
        },
    )


# ========== 项目任务 ==========


@router.get("/{id}/tasks")
async def project_tasks(id: str, req: Request, db: AsyncSession = Depends(get_db)):
    await _get_project(db, id)
    page = max(1, int(req.query_params.get("page") or 1))
    page_size = min(100, max(1, int(req.query_params.get("pageSize") or 20)))
    where = GenTask.project_id == id
    total = (
        await db.execute(select(func.count(GenTask.id)).where(where))
    ).scalar() or 0
    tasks = (
        (
            await db.execute(
                select(GenTask)
                .where(where)
                .order_by(GenTask.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )
    return json.loads(
        json.dumps(
            {
                "total": total,
                "page": page,
                "pageSize": page_size,
                "tasks": [_task_brief(t) for t in tasks],
            },
            default=str,
        )
    )


@router.post("/{id}/tasks")
async def project_tasks_action(
    id: str, req: Request, db: AsyncSession = Depends(get_db)
):
    await _get_project(db, id)
    try:
        body = await req.json()
    except Exception:
        body = {}
    action = body.get("action")
    if action == "retryFailed":
        failed = (
            (
                await db.execute(
                    select(GenTask).where(
                        GenTask.project_id == id,
                        GenTask.status.in_(["FAILED", "REJECTED"]),
                    )
                )
            )
            .scalars()
            .all()
        )
        ok_count = 0
        errors = []
        for t in failed:
            r = await retry_gen_task(db, t.id)
            if r["ok"]:
                ok_count += 1
            elif r.get("error"):
                errors.append(f"{t.id}: {r['error']}")
        await db.flush()
        return {
            "ok": True,
            "action": action,
            "total": len(failed),
            "succeeded": ok_count,
            "failed": len(failed) - ok_count,
            "retriedTasks": [
                {"id": t.id, "label": t.label, "provider": t.provider} for t in failed
            ],
            "errors": errors[:5] or None,
        }
    if action == "resumePaused":
        paused = (
            (
                await db.execute(
                    select(GenTask).where(
                        GenTask.project_id == id, GenTask.status == "PAUSED"
                    )
                )
            )
            .scalars()
            .all()
        )
        ok_count = 0
        errors = []
        for t in paused:
            r = await resume_gen_task(db, t.id)
            if r["ok"]:
                ok_count += 1
            elif r.get("error"):
                errors.append(f"{t.id}: {r['error']}")
        await db.flush()
        return {
            "ok": True,
            "action": action,
            "total": len(paused),
            "succeeded": ok_count,
            "failed": len(paused) - ok_count,
            "errors": errors[:5] or None,
        }
    raise HTTPException(400, "action 必须是 retryFailed | resumePaused")
