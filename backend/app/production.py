"""逐集串行生产（Episode 状态机 + 自动推进）

目标：生成视频时，第 N 集的全部镜头（分镜图 → 视频 → 配音）完成并
合成成功后，才自动开始第 N+1 集；任一集失败则停住等待人工重试。

Episode.status 流转：
    draft → producing → composing → composed
                     ↘ failed（重试后回到 producing）

推进入口：
    - POST /projects/{id}/produce          手动/自动开始（advance_project）
    - video / audio / compose 任务落定后   settle_episode_step（驱动同集下一步）
    - compose 成功后                       advance_project（进入下一集）
全部步骤幂等：重复调用不会重复入队（以 Shot 状态 + 在途任务双重判重）。
"""

from __future__ import annotations

import logging
import os
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Episode, GenTask, Shot, Character

logger = logging.getLogger("production")

EP_PRODUCING = "producing"
EP_COMPOSING = "composing"
EP_COMPOSED = "composed"
EP_FAILED = "failed"
# 人工跳过（D5）：失败镜头可显式跳过，流水线按"该镜头不存在"继续
SHOT_SKIPPED = "SKIPPED"

# 视为"已完结"的集状态（"DONE" 来自 compose/index.py，"composed" 为兼容值）
_EP_FINISHED = ("DONE", "composed")
# 该集存在这些镜头状态 → 集失败，流水线停住
_SHOT_FAIL_STATUSES = ("IMAGE_FAILED", "VIDEO_FAILED", "VOICE_FAILED")


async def _auto_advance_enabled(db: AsyncSession) -> bool:
    """自动连播开关（D3 默认开）：DB `sched.autoAdvance` > env SCHED_AUTO_ADVANCE > True"""
    from app.providers.settings import get_setting_async

    v = ((await get_setting_async("sched.autoAdvance")) or "").strip().lower()
    if v in ("true", "1", "on", "yes"):
        return True
    if v in ("false", "0", "off", "no"):
        return False
    env = os.environ.get("SCHED_AUTO_ADVANCE", "").strip().lower()
    if env in ("false", "0", "off", "no"):
        return False
    return True


async def _pipeline_paused(db: AsyncSession) -> bool:
    from app.pipeline import get_pipeline_paused

    try:
        return await get_pipeline_paused(db)
    except Exception:  # noqa: BLE001 —— 读取失败按未暂停处理，避免阻断推进
        return False


async def skip_failed_shots(
    db: AsyncSession, project_id: str, episode_number: int | None = None
) -> int:
    """把失败镜头标记为 SKIPPED（D5 跳过入口）。

    episode_number 为空则作用于项目全部集；返回跳过数量。
    跳过后的镜头被 resume_episode_chain / 闸门视为"不参与生产"。
    """
    conds = [Episode.project_id == project_id]
    if episode_number:
        conds.append(Episode.number == episode_number)
    ep_ids = (await db.execute(select(Episode.id).where(*conds))).scalars().all()
    if not ep_ids:
        return 0
    result = await db.execute(
        update(Shot)
        .where(
            Shot.episode_id.in_(ep_ids),
            Shot.status.in_(_SHOT_FAIL_STATUSES),
        )
        .values(status=SHOT_SKIPPED)
    )
    n = result.rowcount or 0
    logger.info(
        "[production] 跳过失败镜头 %d 个（project=%s ep=%s）",
        n,
        project_id,
        episode_number,
    )
    return n


def episode_progress(shots: list[Shot]) -> dict[str, int]:
    """单集各阶段进度计数（前端进度条数据）"""
    return {
        "total": len(shots),
        "imageDone": sum(1 for s in shots if s.image_path),
        "videoDone": sum(1 for s in shots if s.video_path),
        "voiceDone": sum(1 for s in shots if s.voice_path),
        "failed": sum(1 for s in shots if s.status in _SHOT_FAIL_STATUSES),
    }


async def _running_count(db: AsyncSession, project_id: str, types: list[str]) -> int:
    return (
        await db.execute(
            select(func.count(GenTask.id)).where(
                GenTask.project_id == project_id,
                GenTask.type.in_(types),
                GenTask.status.in_(["QUEUED", "PROCESSING"]),
            )
        )
    ).scalar() or 0


async def _episode_shots(db: AsyncSession, episode_id: str) -> list[Shot]:
    return (
        (
            await db.execute(
                select(Shot)
                .where(Shot.episode_id == episode_id)
                .order_by(Shot.sequence.asc())
            )
        )
        .scalars()
        .all()
    )


async def mark_episode_failed(db: AsyncSession, episode_id: str, error: str) -> None:
    """集内任一步骤失败：Episode 置 failed，流水线停住（重试成功后继续推进）"""
    await db.execute(
        update(Episode).where(Episode.id == episode_id).values(status=EP_FAILED)
    )
    logger.warning("[production] 第 %s 集失败停住: %s", episode_id, error)


# ========== 单集链路：分镜图 → 视频 → 配音 → 合成 ==========


async def _enqueue_images(
    db, project_id: str, episode: Episode, shots: list[Shot]
) -> int:
    """给缺分镜图的镜头入队出图任务"""
    from app.queue import enqueue_gen_task

    ready = [
        s
        for s in shots
        if s.final_prompt and s.status not in ("IMAGE_GENERATING",) and not s.image_path
    ]
    for shot in ready:
        task = GenTask(
            project_id=project_id,
            label=f"分镜图·第{episode.number}集#{shot.sequence}",
            type="IMAGE",
            provider="agnes",
            model="agnes-image-2.5-flash",
            ref_type="shot",
            ref_id=shot.id,
            status="QUEUED",
            input={"shotId": shot.id, "episodeNumber": episode.number},
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
    return len(ready)


async def _enqueue_videos(
    db, project_id: str, episode: Episode, shots: list[Shot]
) -> int:
    from app.queue import enqueue_gen_task
    from app.compose.prompts import build_motion_prompt

    ready = [
        s
        for s in shots
        if s.image_path and s.status not in ("VIDEO_GENERATING", "VIDEO_DONE")
    ]
    for shot in ready:
        task = GenTask(
            project_id=project_id,
            label=f"视频·第{episode.number}集#{shot.sequence}",
            type="VIDEO",
            provider="agnes",
            model="agnes-video-2.5-flash",
            ref_type="shot",
            ref_id=shot.id,
            status="QUEUED",
            input={"shotId": shot.id, "episodeNumber": episode.number},
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
                "prompt": await build_motion_prompt(shot_dict, project_id),
                "duration": 5,
            },
        )
    return len(ready)


async def _enqueue_voices(
    db, project_id: str, episode: Episode, shots: list[Shot]
) -> int:
    from app.queue import enqueue_gen_task
    from app.providers.settings import get_tts_config

    ready = [
        s
        for s in shots
        if s.dialog
        and s.status != "VOICE_GENERATING"
        and (s.video_path or s.image_path)
        and not s.voice_path
    ]
    if not ready:
        return 0
    chars = (
        (await db.execute(select(Character).where(Character.project_id == project_id)))
        .scalars()
        .all()
    )
    voice_by_char = {c.name: (c.voice_id or c.voice_name) for c in chars}
    tts_cfg = get_tts_config()
    tts_provider = tts_cfg.get("engine") or "mock"
    for shot in ready:
        task = GenTask(
            project_id=project_id,
            label=f"配音·第{episode.number}集#{shot.sequence}"
            + (f"·{shot.dialog_char}" if shot.dialog_char else ""),
            type="TTS",
            provider=tts_provider,
            model=tts_cfg.get("model") or "tts",
            ref_type="shot",
            ref_id=shot.id,
            status="QUEUED",
            input={"shotId": shot.id, "episodeNumber": episode.number},
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
    return len(ready)


async def _enqueue_compose(db, project_id: str, episode: Episode) -> bool:
    from app.queue import enqueue_gen_task

    task = GenTask(
        project_id=project_id,
        label=f"合成·第{episode.number}集",
        type="COMPOSE",
        provider="ffmpeg",
        model="compose",
        status="QUEUED",
        input={"episodeId": episode.id},
    )
    db.add(task)
    await db.flush()
    await db.execute(
        update(Episode).where(Episode.id == episode.id).values(status=EP_COMPOSING)
    )
    enqueue_gen_task("compose", task.id, {"episodeId": episode.id})
    return True


async def resume_episode_chain(
    db: AsyncSession, project_id: str, episode: Episode
) -> str | None:
    """推动单集链路到下一个缺口步骤（幂等）。返回启动的阶段名或 None。"""
    shots = await _episode_shots(db, episode.id)
    if not shots:
        return None
    if any(s.status in _SHOT_FAIL_STATUSES for s in shots):
        await mark_episode_failed(db, episode.id, "存在失败镜头")
        return None

    # 步骤 1：分镜图（SKIPPED 镜头视为不参与生产）
    missing_images = [s for s in shots if not s.image_path and s.status != SHOT_SKIPPED]
    if missing_images:
        if await _running_count(db, project_id, ["IMAGE"]) > 0:
            return None  # 在途，等任务落定再推进
        n = await _enqueue_images(db, project_id, episode, shots)
        if n:
            await db.execute(
                update(Episode)
                .where(Episode.id == episode.id)
                .values(status=EP_PRODUCING)
            )
            logger.info("[production] 第%d集 启动出图 %d 个镜头", episode.number, n)
            return "images"

    # 步骤 2：视频（一集全部镜头出图完成后才开始）
    missing_videos = [s for s in shots if not s.video_path and s.status != SHOT_SKIPPED]
    if missing_videos:
        if await _running_count(db, project_id, ["VIDEO"]) > 0:
            return None
        n = await _enqueue_videos(db, project_id, episode, shots)
        if n:
            await db.execute(
                update(Episode)
                .where(Episode.id == episode.id)
                .values(status=EP_PRODUCING)
            )
            logger.info("[production] 第%d集 启动视频 %d 个镜头", episode.number, n)
            return "video"

    # 步骤 3：配音
    needs_voice = [
        s
        for s in shots
        if s.dialog
        and not s.voice_path
        and not s.subtitle_path
        and s.status != SHOT_SKIPPED
    ]
    if needs_voice:
        if await _running_count(db, project_id, ["TTS"]) > 0:
            return None
        n = await _enqueue_voices(db, project_id, episode, shots)
        if n:
            logger.info("[production] 第%d集 启动配音 %d 个镜头", episode.number, n)
            return "voice"

    # 步骤 4：合成
    if not episode.final_path and episode.status != EP_COMPOSING:
        with_video = [s for s in shots if s.video_path]
        if with_video:
            await _enqueue_compose(db, project_id, episode)
            logger.info("[production] 第%d集 启动合成", episode.number)
            return "compose"
    return None


# ========== 项目级推进：一次只有一集在生产 ==========


async def _has_active_production(db: AsyncSession, project_id: str) -> bool:
    """项目内是否存在 IMAGE/VIDEO/TTS/COMPOSE 在途任务（任意集）"""
    return (
        await _running_count(db, project_id, ["IMAGE", "VIDEO", "TTS", "COMPOSE"])
    ) > 0


async def advance_project(db: AsyncSession, project_id: str) -> dict[str, Any]:
    """找到第一个未完结且有镜头的集，串行推进。

    规则：
    - 已有集在 producing/composing 且链路在途 → 不动（等落定回调）。
    - 该集链路全部落定但未完结（如刚恢复）→ resume_episode_chain 续跑。
    - 没有集在生产 → 从第一个未完结集开始。
    返回 {started: bool, episodeNumber, stage}。
    """
    episodes = (
        (
            await db.execute(
                select(Episode)
                .where(Episode.project_id == project_id)
                .order_by(Episode.number.asc())
            )
        )
        .scalars()
        .all()
    )
    for ep in episodes:
        if ep.status in _EP_FINISHED:
            continue
        shots = await _episode_shots(db, ep.id)
        if not shots:
            continue  # 尚未分镜的集跳过（剧本/分镜就绪后由 produce 端点启动）
        if any(s.status in _SHOT_FAIL_STATUSES for s in shots):
            # 同步集状态为 failed：让前端徽标/提示与门控行为一致
            if ep.status != EP_FAILED:
                await mark_episode_failed(db, ep.id, "存在失败镜头")
            return {
                "started": False,
                "episodeNumber": ep.number,
                "stage": "failed",
                "reason": "存在失败镜头，请重试后继续",
            }
        stage = await resume_episode_chain(db, project_id, ep)
        if stage:
            return {"started": True, "episodeNumber": ep.number, "stage": stage}
        # 该集在途任务运行中 → 串行门控生效，等待
        return {
            "started": False,
            "episodeNumber": ep.number,
            "stage": "running",
            "reason": "当前集任务进行中（一集完成后自动进入下一集）",
        }
    return {"started": False, "episodeNumber": None, "stage": "all_done"}


async def settle_episode_step(
    db: AsyncSession, project_id: str, episode_id: str | None
) -> None:
    """任务落定钩子：VIDEO/TTS/COMPOSE 任务 done/failed 后调用。

    - 同集还有缺口 → 续跑链路（video 完 → 配音 → 合成）
    - 失败 → 集置 failed 停住
    - compose 成功 → advance_project 进入下一集
    自动推进受「流水线暂停」与「自动连播开关（D3）」约束；显式 POST produce 不受限制。
    """
    if not episode_id:
        return
    episode = (
        await db.execute(select(Episode).where(Episode.id == episode_id))
    ).scalar_one_or_none()
    if not episode or episode.status in _EP_FINISHED:
        return
    # 失败镜头 bookkeeping 不依赖开关；自动续链与推进依赖
    if await _pipeline_paused(db) or not await _auto_advance_enabled(db):
        return
    stage = await resume_episode_chain(db, project_id, episode)
    if stage is None and episode.status not in (EP_PRODUCING, EP_COMPOSING, EP_FAILED):
        await advance_project(db, project_id)


async def first_blocking_episode(
    db: AsyncSession, project_id: str, episode_number: int
) -> dict[str, Any] | None:
    """视频闸门：episode_number 之前的集若仍有镜头未完成视频生成 → 返回阻塞详情，否则 None。

    SKIPPED 镜头不参与判定（D5：跳过即放行该镜头）。
    """
    episodes = (
        (
            await db.execute(
                select(Episode)
                .where(
                    Episode.project_id == project_id,
                    Episode.number < episode_number,
                )
                .order_by(Episode.number.asc())
            )
        )
        .scalars()
        .all()
    )
    for ep in episodes:
        shots = await _episode_shots(db, ep.id)
        if not shots:
            return {
                "blockedBy": ep.number,
                "missing": 0,
                "failed": 0,
                "reason": f"第{ep.number}集尚未分镜（请先完成第{ep.number}集）",
            }
        active = [s for s in shots if s.status != SHOT_SKIPPED]
        missing = [s for s in active if not s.video_path]
        failed = [s for s in active if s.status in _SHOT_FAIL_STATUSES]
        if missing:
            reason = f"第{ep.number}集还有{len(missing)}个镜头未完成视频"
            if failed:
                reason += f"（其中{len(failed)}个失败，可重试或调用 produce + skipFailed 跳过）"
            return {
                "blockedBy": ep.number,
                "missing": len(missing),
                "failed": len(failed),
                "reason": reason,
            }
    return None


async def settle_shot_step(db: AsyncSession, shot_id: str | None) -> None:
    """镜头级任务（VIDEO/TTS/IMAGE）落定钩子：shot → episode → 逐集推进"""
    if not shot_id:
        return
    shot = (
        await db.execute(select(Shot).where(Shot.id == shot_id))
    ).scalar_one_or_none()
    if not shot:
        return
    episode = (
        await db.execute(select(Episode).where(Episode.id == shot.episode_id))
    ).scalar_one_or_none()
    if not episode or episode.status in _EP_FINISHED:
        return
    await settle_episode_step(db, episode.project_id, episode.id)


async def settle_compose_step(db: AsyncSession, episode_id: str | None) -> None:
    """合成任务落定钩子：成功 → 进入下一集；失败 → 本集停住"""
    if not episode_id:
        return
    episode = (
        await db.execute(select(Episode).where(Episode.id == episode_id))
    ).scalar_one_or_none()
    if not episode:
        return
    if episode.final_path:
        # 本集完结，推进下一集（串行门控在这里兑现）
        logger.info("[production] 第%d集 合成完成，推进下一集", episode.number)
        await advance_project(db, episode.project_id)
    else:
        await mark_episode_failed(db, episode.id, "合成未产出最终视频")
