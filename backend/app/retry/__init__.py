"""任务重试/恢复

核心原则：GenTask.input 只是费用估算快照（prompt 截断、字段残缺），
入队 payload 必须从业务表（Shot/Character/Scene/Asset/Episode）实时重建，否则任务会走错误分支。
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import GenTask, Shot, Character, Scene, Project, Asset, Episode
from app.queue import enqueue_gen_task
from app.json_utils import as_list, as_record
from app.assets.prompts import (
    character_design_prompt,
    scene_design_prompt,
    prop_design_prompt,
    style_anchor,
)
from app.compose.prompts import build_motion_prompt

DEFAULT_MAX_RETRIES = 3
BASE_DELAY_MS = 1000
MAX_DELAY_MS = 60_000


def get_backoff_delay(
    attempt: int, base_ms: int = BASE_DELAY_MS, max_ms: int = MAX_DELAY_MS
) -> int:
    return min(base_ms * (2**attempt), max_ms)


def is_4xx_error(error: Any) -> bool:
    import re

    if not error:
        return False
    if isinstance(error, dict):
        status = error.get("status") or error.get("statusCode")
        if isinstance(status, int) and 400 <= status < 500:
            return True
        msg = str(error.get("message", ""))
        if re.search(r"\b4\d{2}\b", msg):
            return True
    msg = str(error)
    return bool(re.search(r"\b4\d{2}\b", msg))


# ========== payload 重建（核心） ==========


async def rebuild_gen_task_payload(db: AsyncSession, task: GenTask) -> dict[str, Any]:
    """从 GenTask 元数据 + 业务表重建入队 payload。
    返回 {ok: True, queueName, payload} 或 {ok: False, error}。
    """
    input_ = as_record(task.input)
    episode_number = input_.get("episodeNumber")

    provider = task.provider or ""
    # 按任务类型优先分发（agnes 同时是图像/视频 provider，仅靠 provider 会错配：
    # 视频任务 provider=agnes+ref_type=shot 会命中图像分支，重试实际重跑出图）
    task_type = (task.type or "").upper()

    # script-agent（LLM）
    if task_type == "LLM" or provider in ("script-agent", "mock-llm"):
        agent = task.model or "characters"
        payload: dict[str, Any] = {"agent": agent, "projectId": task.project_id}
        if episode_number:
            payload["episodeNumber"] = int(episode_number)
        if task.input and task.input.get("episodeCount"):
            payload["episodeCount"] = int(task.input["episodeCount"])
        return {"ok": True, "queueName": "script", "payload": payload}

    # 视频任务（先于图像判断，防止 agnes 错配）
    if task_type == "VIDEO" or provider in ("mock-video", "kling"):
        shot = (
            (
                await db.execute(select(Shot).where(Shot.id == task.ref_id))
            ).scalar_one_or_none()
            if task.ref_id
            else None
        )
        if not shot:
            return {"ok": False, "error": "关联镜头不存在，请先在分镜车间出图"}
        if not shot.image_path:
            return {"ok": False, "error": "镜头没有分镜图，请先出图"}
        await db.execute(
            update(Shot).where(Shot.id == shot.id).values(status="VIDEO_GENERATING")
        )
        shot_dict = {
            "sceneName": shot.scene_name,
            "camera": as_record(shot.camera),
            "action": shot.action,
            "dialog": shot.dialog,
            "dialogChar": shot.dialog_char,
            "dialogEmotion": shot.dialog_emotion,
            "duration": shot.duration,
        }
        return {
            "ok": True,
            "queueName": "video",
            "payload": {
                "shotId": shot.id,
                "imagePath": shot.image_path,
                "prompt": await build_motion_prompt(shot_dict, task.project_id),
                "duration": 5,
            },
        }

    # 图像任务（Agnes / mock-image / seedream 历史兼容）
    if task_type == "IMAGE" or provider in ("agnes", "mock-image", "seedream"):
        ref_type = task.ref_type or "shot"
        ref_type = task.ref_type or "shot"

        project = None
        if task.project_id:
            project = (
                await db.execute(select(Project).where(Project.id == task.project_id))
            ).scalar_one_or_none()
        anchor = style_anchor(as_record(project.style) if project else None)

        # 分镜出图
        if ref_type == "shot":
            shot = (
                await db.execute(select(Shot).where(Shot.id == task.ref_id))
            ).scalar_one_or_none()
            if not shot:
                return {"ok": False, "error": "关联镜头不存在，请在分镜车间重新出图"}
            if not shot.final_prompt:
                return {
                    "ok": False,
                    "error": "镜头缺少 finalPrompt，请在分镜车间重新出图",
                }
            await db.execute(
                update(Shot).where(Shot.id == shot.id).values(status="IMAGE_GENERATING")
            )
            return {
                "ok": True,
                "queueName": "image",
                "payload": {
                    "prompt": shot.final_prompt,
                    "refImages": as_list(shot.ref_images),
                    "count": 1,
                    "aspectRatio": "16:9",
                    "shotId": shot.id,
                    "category": "shots",
                },
            }

        # 角色定妆照
        if ref_type == "character":
            character = (
                await db.execute(select(Character).where(Character.id == task.ref_id))
            ).scalar_one_or_none()
            if not character:
                return {"ok": False, "error": "关联角色不存在，请重新生成定妆照"}
            ref_image_ids = as_list(character.ref_image_ids)
            locked = len(ref_image_ids) > 0 and character.status == "APPROVED"
            angle = input_.get("angle") or "front"
            if locked or angle not in ("front", "three-quarter", "full"):
                angle = "three-quarter"
            prompt = await character_design_prompt(
                {
                    "name": character.name,
                    "role": character.role,
                    "gender": character.gender,
                    "appearance": as_record(character.appearance),
                    "refImageIds": ref_image_ids,
                },
                anchor,
                angle,
                task.project_id,
            )
            return {
                "ok": True,
                "queueName": "image",
                "payload": {
                    "prompt": prompt,
                    "refImages": ref_image_ids if locked else [],
                    "count": 1,
                    "aspectRatio": "3:4",
                    "refType": "character",
                    "refId": character.id,
                    "category": "characters",
                },
            }

        # 场景空镜
        if ref_type == "scene":
            scene = (
                await db.execute(select(Scene).where(Scene.id == task.ref_id))
            ).scalar_one_or_none()
            if not scene:
                return {"ok": False, "error": "关联场景不存在，请重新生成空镜"}
            ref_image_ids = as_list(scene.ref_image_ids)
            prompt = await scene_design_prompt(
                {
                    "name": scene.name,
                    "description": scene.description,
                    "mood": scene.mood,
                    "refImageIds": ref_image_ids,
                },
                anchor,
                task.project_id,
            )
            return {
                "ok": True,
                "queueName": "image",
                "payload": {
                    "prompt": prompt,
                    "refImages": ref_image_ids,
                    "count": 1,
                    "aspectRatio": "16:9",
                    "refType": "scene",
                    "refId": scene.id,
                    "category": "scenes",
                },
            }

        # 道具
        if ref_type == "asset":
            asset = (
                await db.execute(select(Asset).where(Asset.id == task.ref_id))
            ).scalar_one_or_none()
            if not asset:
                return {"ok": False, "error": "关联道具不存在，请重新生成"}
            desc = as_record(asset.meta).get("desc", "")
            prompt = await prop_design_prompt(asset.name, desc, anchor, task.project_id)
            ref_image_ids = as_list(asset.image_ids)
            return {
                "ok": True,
                "queueName": "image",
                "payload": {
                    "prompt": prompt,
                    "refImages": ref_image_ids,
                    "count": 1,
                    "aspectRatio": "16:9",
                    "refType": "asset",
                    "refId": asset.id,
                    "category": "props",
                },
            }

        return {"ok": False, "error": f"不支持的图像 refType: {ref_type}"}

    # TTS 配音（mimo/tokendance/confucius4/voxcpm 与历史 engine 名统一按 type=TTS 分发）
    if task_type == "TTS" or provider in (
        "cosyvoice",
        "edge-tts",
        "mock-tts",
        "mimo",
        "tokendance",
        "confucius4",
        "voxcpm",
    ):
        input_ = as_record(task.input)
        if input_.get("batch") and not task.ref_id:
            return {
                "ok": False,
                "error": "批量配音为旧版格式，无法直接恢复，请按镜头重新配音",
            }
        shot = (
            (
                await db.execute(select(Shot).where(Shot.id == task.ref_id))
            ).scalar_one_or_none()
            if task.ref_id
            else None
        )
        if not shot:
            return {"ok": False, "error": "关联镜头不存在"}
        if not shot.dialog:
            return {"ok": False, "error": "镜头没有台词，无法配音"}
        voice_id = await _get_voice_for_shot(db, shot)
        await db.execute(
            update(Shot).where(Shot.id == shot.id).values(status="VOICE_GENERATING")
        )
        return {
            "ok": True,
            "queueName": "audio",
            "payload": {
                "shotId": shot.id,
                "text": shot.dialog,
                "voiceId": voice_id,
                "emotion": shot.dialog_emotion,
            },
        }

    # ffmpeg 合成
    if task_type == "COMPOSE" or provider in ("ffmpeg", "mock-compose"):
        episode_id = task.ref_id
        if not episode_id:
            input_ = as_record(task.input)
            episode_id = input_.get("episodeId")
        if not episode_id:
            return {"ok": False, "error": "缺少剧集信息，请在视频合成厂重新合成"}
        input_ = as_record(task.input)
        return {
            "ok": True,
            "queueName": "compose",
            "payload": {
                "episodeId": episode_id,
                "bgmMood": input_.get("bgmMood"),
            },
        }

    return {"ok": False, "error": f"不支持的 provider: {provider}"}


async def _get_voice_for_shot(db: AsyncSession, shot: Shot) -> str | None:
    """该镜头台词角色 → voiceId 映射"""
    if not shot.dialog_char:
        return None
    episode = (
        await db.execute(select(Episode).where(Episode.id == shot.episode_id))
    ).scalar_one_or_none()
    if not episode:
        return None
    chars = (
        (
            await db.execute(
                select(Character).where(Character.project_id == episode.project_id)
            )
        )
        .scalars()
        .all()
    )
    for c in chars:
        if c.name == shot.dialog_char:
            return c.voice_id or c.voice_name
    return None


# ========== 手动重试（FAILED / REJECTED） ==========


async def retry_gen_task(db: AsyncSession, task_id: str) -> dict[str, Any]:
    """重试失败/拒绝任务：重建 payload 重新入队。4xx 标记 REJECTED 不重试。"""
    task = (
        await db.execute(select(GenTask).where(GenTask.id == task_id))
    ).scalar_one_or_none()
    if not task:
        return {"ok": False, "error": "任务不存在"}
    if task.status not in ("FAILED", "REJECTED"):
        return {"ok": False, "error": "仅失败/拒绝状态的任务可重试"}

    if task.error and is_4xx_error(task.error):
        await db.execute(
            update(GenTask).where(GenTask.id == task_id).values(status="REJECTED")
        )
        await db.flush()
        return {"ok": False, "error": f"4xx 客户端错误，不可自动重试: {task.error}"}

    rebuilt = await rebuild_gen_task_payload(db, task)
    if not rebuilt["ok"]:
        return {"ok": False, "error": rebuilt["error"]}

    retry_job_id = f"{task_id}_retry_{int(time.time() * 1000)}"
    await db.execute(
        update(GenTask).where(GenTask.id == task_id).values(status="QUEUED", error=None)
    )
    await db.flush()
    enqueue_gen_task(
        rebuilt["queueName"],
        task_id,
        rebuilt["payload"],
        job_id=retry_job_id,
    )
    return {"ok": True}


# ========== 恢复暂停任务（PAUSED） ==========


async def resume_gen_task(db: AsyncSession, task_id: str) -> dict[str, Any]:
    """恢复暂停任务：PAUSED → QUEUED 并重新入队。若流水线全局暂停则自动恢复。"""
    from app.pipeline import get_pipeline_paused, set_pipeline_paused

    task = (
        await db.execute(select(GenTask).where(GenTask.id == task_id))
    ).scalar_one_or_none()
    if not task:
        return {"ok": False, "error": "任务不存在"}
    if task.status != "PAUSED":
        return {"ok": False, "error": "仅暂停状态的任务可恢复"}

    rebuilt = await rebuild_gen_task_payload(db, task)
    if not rebuilt["ok"]:
        return {"ok": False, "error": rebuilt["error"]}

    if await get_pipeline_paused(db):
        await set_pipeline_paused(db, False)

    resume_job_id = f"{task_id}_resume_{int(time.time() * 1000)}"
    await db.execute(
        update(GenTask).where(GenTask.id == task_id).values(status="QUEUED", error=None)
    )
    await db.flush()
    enqueue_gen_task(
        rebuilt["queueName"],
        task_id,
        rebuilt["payload"],
        job_id=resume_job_id,
    )
    return {"ok": True}


# ========== 一键恢复全部暂停任务（Worker 重启后批量重放） ==========


async def resume_all_paused_tasks(db: AsyncSession) -> dict[str, Any]:
    """把全部 PAUSED 任务重建 payload 重新入队（Worker 重启后一键继续）。

    逐条复用 resume_gen_task 的重建逻辑；单条失败（业务数据缺失等）
    不中断其余任务，失败明细随结果返回。
    """
    from app.pipeline import get_pipeline_paused, set_pipeline_paused

    ids = (
        (
            await db.execute(
                select(GenTask.id)
                .where(GenTask.status == "PAUSED")
                .order_by(GenTask.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    if not ids:
        return {"ok": True, "resumed": 0, "failed": []}

    if await get_pipeline_paused(db):
        await set_pipeline_paused(db, False)
    await db.commit()

    from app.core.database import SessionLocal

    resumed, failed = 0, []
    for tid in ids:
        async with SessionLocal() as tdb:
            try:
                r = await resume_gen_task(tdb, tid)
                await tdb.commit()
            except Exception as e:  # noqa: BLE001
                r = {"ok": False, "error": str(e)}
                await tdb.rollback()
        if r.get("ok"):
            resumed += 1
        else:
            failed.append({"taskId": tid, "error": r.get("error")})
    return {"ok": True, "resumed": resumed, "failed": failed}
