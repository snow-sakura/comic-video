"""Celery 任务定义 — 五条队列处理器（替代旧 BullMQ Node worker，历史实现见 git 历史）

任务命名规则：与 app/queue.enqueue_gen_task 对齐，
  task_name = f"workers.tasks.{queue_name}_task"
因此每个队列对应一个函数名：script_task / image_task / video_task / audio_task / compose_task。

Celery worker 是同步上下文，而业务逻辑（agents / providers / DB）全部异步，
所以每个任务体内用 app.core.database.run_async 包一个 asyncio.run 事件循环，
并在循环内用 SessionLocal 开一个独立 AsyncSession。

payload 契约（与 enqueue_gen_task 一致）：
  args[0] = {"taskId": <GenTask.id>, **payload}
  - script:  agent ∈ {characters,outline,script,storyboard,plain}, projectId, episodeNumber?, episodeCount?, input?
  - image:   prompt, size?, refImages, count?, aspectRatio?, negativePrompt?, refType?, refId?, shotId?, category?
  - video:   shotId?, imagePath, prompt, refImages?, duration?, tailImagePath?
  - audio:   shotId?, text, voiceId?, emotion?, rate?, sampleRate?
  - compose: episodeId, bgmMood?
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from app.core.celery_app import celery_app
from app.models import GenTask, Shot, Character, Scene, Asset, Episode, Project
from app.json_utils import as_list, as_record, as_string

logger = logging.getLogger(__name__)

# 流水线暂停时，任务最长等待轮询的秒数
_VIDEO_POLL_INTERVAL_SEC = 10
_VIDEO_POLL_MAX_SEC = 20 * 60


def _db():
    """延迟解析 SessionLocal：run_async 会 swap app.core.database.SessionLocal，
    顶层 from-import 会绑死旧对象导致跨事件循环报错，因此每次调用时再解析。"""
    from app.core.database import SessionLocal

    return SessionLocal()


# ========== 通用：会话 + GenTask 状态 ==========


async def _mark_processing(db, task_id: str) -> None:
    task = (await db.execute(_select_task(task_id))).scalar_one_or_none()
    if task:
        task.status = "PROCESSING"
        await db.flush()


async def _mark_done(db, task_id: str) -> None:
    await db.execute(_update_task(task_id, status="DONE", error=None))
    await db.flush()


async def _mark_failed(db, task_id: str, error: str) -> None:
    await db.execute(_update_task(task_id, status="FAILED", error=error))
    await db.flush()


def _fmt_error(stage: str, e: BaseException) -> str:
    """结构化错误摘要：阶段 + 异常类型 + 消息（截断），前端直接展示。"""
    msg = str(e).strip() or e.__class__.__name__
    if len(msg) > 500:
        msg = msg[:500] + "…"
    return f"[{stage}] {e.__class__.__name__}: {msg}"


def _select_task(task_id: str):
    from sqlalchemy import select

    return select(GenTask).where(GenTask.id == task_id)


def _update_task(task_id: str, **values):
    from sqlalchemy import update

    return update(GenTask).where(GenTask.id == task_id).values(**values)


async def _should_skip(task_id: str) -> bool:
    """任务已被 PAUSED/DONE/FAILED/REJECTED/删除时跳过执行。

    入队竞态保护：API 是 flush 后 enqueue、响应结束后才 commit，
    worker 可能先于 commit 收到任务而查不到行。这里短暂等待重查，
    避免任务被静默跳过、永久卡在 QUEUED 锁死后续操作。
    """
    import asyncio

    for attempt in range(8):
        async with _db() as db:
            task = (await db.execute(_select_task(task_id))).scalar_one_or_none()
            if task:
                if task.status in ("PAUSED", "DONE", "FAILED", "REJECTED"):
                    logger.warning(
                        "[worker] 任务 %s 状态=%s，跳过", task_id, task.status
                    )
                    return True
                return False
            # 行还没提交：等 0.5s 重查
            if attempt < 7:
                await asyncio.sleep(0.5)
    logger.warning("[worker] 任务 %s 持续不存在，跳过（可能已被删除）", task_id)
    return True


# ========== script 任务 ==========


async def _script_handler(data: dict[str, Any]) -> dict[str, Any]:
    from app.agents import (
        run_extract_characters,
        run_generate_outline,
        run_generate_episode,
        run_storyboard,
    )
    from app.providers.registry import get_text_llm
    from app.providers.base import LLMOptions
    from app.cost import record_cost

    task_id = data["taskId"]
    agent = data.get("agent")
    project_id = data.get("projectId")
    episode_number = data.get("episodeNumber")
    episode_count = data.get("episodeCount")
    input_ = data.get("input")

    async with _db() as db:
        try:
            if await _should_skip(task_id):
                return {}
            await _mark_processing(db, task_id)
            await db.commit()  # 持久化 PROCESSING 状态

            try:
                if agent == "characters":
                    if not project_id:
                        raise ValueError("缺少 projectId")
                    r = await run_extract_characters(db, project_id)
                    result = {**r, "agent": agent}
                elif agent == "outline":
                    if not project_id:
                        raise ValueError("缺少 projectId")
                    r = await run_generate_outline(db, project_id, episode_count)
                    result = {**r, "agent": agent}
                elif agent == "script":
                    if not project_id or not episode_number:
                        raise ValueError("缺少 projectId/episodeNumber")
                    r = await run_generate_episode(db, project_id, int(episode_number))
                    result = {"episode": r, "agent": agent}
                elif agent == "storyboard":
                    if not project_id or not episode_number:
                        raise ValueError("缺少 projectId/episodeNumber")
                    r = await run_storyboard(db, project_id, int(episode_number))
                    result = {**r, "agent": agent}
                else:
                    # plain：直接透传 LLM 调用（诊断/扩展）
                    llm = get_text_llm()
                    out = await llm.chat(
                        [
                            {
                                "role": "system",
                                "content": "你是漫剧创作助手。必须输出 JSON。",
                            },
                            {"role": "user", "content": as_string(input_)},
                        ],
                        LLMOptions(json=True),
                    )
                    result = {"output": out, "agent": "plain"}

                # 先提交 agent 的落库结果（角色/大纲/剧本/镜头）
                await db.commit()

                # 费用估算（LLM 按小说规模 + 结果字符数）
                input_chars = len(as_string(input_))
                if project_id:
                    proj = (
                        await db.execute(_select_project(project_id))
                    ).scalar_one_or_none()
                    if proj and proj.novel_text:
                        input_chars = len(proj.novel_text)
                await record_cost(
                    db,
                    task_id,
                    kind="llm",
                    input_chars=input_chars,
                    output_chars=len(json.dumps(result, ensure_ascii=False)),
                )
                await _mark_done(db, task_id)
                await db.commit()
                logger.info("[script] 任务 %s 完成 agent=%s", task_id, agent)
                return result
            except Exception as e:
                logger.warning("[script] 任务 %s 失败: %s", task_id, e)
                await _mark_failed(db, task_id, _fmt_error("剧本/分镜", e))
                await db.commit()
                raise
        except Exception as e:
            logger.exception("[script] 任务 %s 未捕获异常: %s", task_id, e)
            raise


def _select_project(project_id: str):
    from sqlalchemy import select

    return select(Project).where(Project.id == project_id)


@celery_app.task(name="workers.tasks.script_task")
def script_task(data: dict[str, Any]) -> dict[str, Any]:
    """script 队列：剧本工坊 LLM 长任务"""
    from app.core.database import run_async

    return run_async(_script_handler(data))


# ========== image 任务 ==========


async def _image_handler(data: dict[str, Any]) -> dict[str, Any]:
    from app.providers.registry import get_image
    from app.cost import record_cost

    task_id = data["taskId"]
    prompt = as_string(data.get("prompt"))
    ref_images = as_list(data.get("refImages"))
    if isinstance(ref_images, list):
        ref_images = ref_images
    shot_id = as_string(data.get("shotId")) or None
    ref_type = data.get("refType")
    ref_id = data.get("refId")
    category = data.get("category")

    async with _db() as db:
        try:
            if await _should_skip(task_id):
                return {}
            await _mark_processing(db, task_id)
            await db.commit()

            try:
                image = get_image()
                handle = await image.generate(
                    {
                        "prompt": prompt,
                        "size": data.get("size"),
                        "refImages": ref_images,
                        "count": data.get("count") or 1,
                        "aspectRatio": data.get("aspectRatio"),
                        "negativePrompt": data.get("negativePrompt"),
                        "category": category,
                    }
                )
                if handle.status == "failed":
                    raise RuntimeError(handle.error or "图像生成失败")
                image_paths = (handle.result or {}).get("imagePaths", [])
                # provider 报 done 但 0 张图：必须判失败，否则 shot 永远卡 IMAGE_GENERATING
                if not image_paths:
                    raise RuntimeError("图像生成返回空结果（0 张图片），已标记失败")

                # 资产生成 → 回写角色/场景/道具资源表
                if ref_id and image_paths:
                    if ref_type == "character":
                        c = (
                            await db.execute(_select_character(ref_id))
                        ).scalar_one_or_none()
                        if c:
                            c.ref_image_ids = as_list(c.ref_image_ids) + image_paths
                    elif ref_type == "scene":
                        s = (
                            await db.execute(_select_scene(ref_id))
                        ).scalar_one_or_none()
                        if s:
                            s.ref_image_ids = as_list(s.ref_image_ids) + image_paths
                    elif ref_type == "asset":
                        a = (
                            await db.execute(_select_asset(ref_id))
                        ).scalar_one_or_none()
                        if a:
                            a.image_ids = as_list(a.image_ids) + image_paths

                # 分镜出图 → 回写 Shot
                if shot_id and image_paths:
                    await db.execute(
                        _update_shot(
                            shot_id,
                            image_path=image_paths[0],
                            status="IMAGE_DONE",
                        )
                    )

                result = {"imagePaths": image_paths}
                await record_cost(db, task_id, kind="image", count=len(image_paths))
                await _mark_done(db, task_id)
                await db.commit()
                logger.info("[image] 任务 %s 完成 paths=%d", task_id, len(image_paths))
                return result
            except Exception as e:
                # Agnes 503/限流/瞬态网络：自动延迟重入队，不落 FAILED（否则需人工逐个重试）
                retry_n = int(data.get("_retryN") or 0)
                if _is_transient_error(e) and retry_n < _RATE_LIMIT_MAX_RETRY:
                    delay = min(60 * (retry_n + 1), 300)
                    _requeue_self("image", data, retry_n + 1, delay)
                    # 刷新 updated_at：清扫器以此判断"有活动"，不会误杀限流等待中的任务；
                    # 同步写入语义化等待文案（status 保持 PROCESSING，前端据此显示"限流等待重试"）
                    await db.execute(
                        _update_task(
                            task_id,
                            updated_at=datetime.now(timezone.utc),
                            error=f"限流等待重试（第{retry_n + 1}次），约 {delay} 秒后重试",
                        )
                    )
                    # 保持 PROCESSING：闸门继续关闭，UI 显示进行中
                    await db.commit()
                    logger.warning(
                        "[image] 任务 %s 限流，%ds 后第%d次重试",
                        task_id,
                        delay,
                        retry_n + 1,
                    )
                    return {"rateLimited": True, "retry": retry_n + 1}
                if shot_id:
                    await db.execute(_update_shot(shot_id, status="IMAGE_FAILED"))
                await _mark_failed(db, task_id, _fmt_error("出图", e))
                await db.commit()
                logger.warning("[image] 任务 %s 失败: %s", task_id, e)
                raise
        except Exception as e:
            logger.exception("[image] 任务 %s 未捕获异常: %s", task_id, e)
            raise


_RATE_LIMIT_MAX_RETRY = 6

# 瞬态网络异常（倾向重试而非失败；与限流同等对待）
_TRANSIENT_EXC_NAMES = frozenset(
    {"ConnectError", "ConnectTimeout", "ReadTimeout", "PoolTimeout", "ReadError"}
)


def _is_transient_error(e: BaseException) -> bool:
    """识别值得重试的错误：Agnes 限流/队列满 + 瞬态网络异常"""
    return _is_rate_limit_error(str(e)) or e.__class__.__name__ in _TRANSIENT_EXC_NAMES


def _is_rate_limit_error(msg: str) -> bool:
    """识别 Agnes 限流/队列满类错误（这些值得等了再试，参数错误不值得）"""
    m = msg.lower()
    return any(
        k in m for k in ("限流", "429", "503", "queue_full", "每分钟最多", "重试耗尽")
    )


def _requeue_self(
    kind: str, data: dict[str, Any], retry_n: int, countdown: int
) -> None:
    """把当前任务连同 payload 延迟重新入队（不新建 GenTask，沿用原 taskId）

    kind 传逻辑队列（image/video/...）；物理队列优先沿用 payload `_tier`
    （首次入队时按档位路由记下的通道），无则按模型/配置重新解析，
    避免付费任务在重入时误回落到免费串行队列。
    """
    from app.queue import resolve_queue

    tier = data.get("_tier")
    physical = (
        f"{kind}.{tier}"
        if tier in ("free", "paid")
        else resolve_queue(kind, data.get("model") or data.get("modelName"))
    )
    payload = dict(data)
    payload["_retryN"] = retry_n
    celery_app.send_task(
        f"workers.tasks.{kind}_task",
        args=[payload],
        queue=physical,
        countdown=countdown,
    )


def _select_character(cid):
    from sqlalchemy import select

    return select(Character).where(Character.id == cid)


def _select_scene(sid):
    from sqlalchemy import select

    return select(Scene).where(Scene.id == sid)


def _select_asset(aid):
    from sqlalchemy import select

    return select(Asset).where(Asset.id == aid)


def _update_shot(shot_id: str, **values):
    from sqlalchemy import update

    return update(Shot).where(Shot.id == shot_id).values(**values)


@celery_app.task(name="workers.tasks.image_task")
def image_task(data: dict[str, Any]) -> dict[str, Any]:
    """image 队列：分镜/资产出图"""
    from app.core.database import run_async

    try:
        return run_async(_image_handler(data))
    finally:
        # 逐集串行推进：出图落定后驱动同集链路（出图完 → 该集视频）
        try:
            run_async(_settle_after(data))
        except Exception as se:  # noqa: BLE001 —— 推进失败不影响任务结果
            logger.warning("[image] 逐集推进钩子异常: %s", se)


# ========== video 任务 ==========


async def _video_handler(data: dict[str, Any]) -> dict[str, Any]:
    from app.providers.registry import get_video
    from app.pipeline import get_pipeline_paused
    from app.quality import qc_video
    from app.cost import record_cost

    task_id = data["taskId"]
    image_path = as_string(data.get("imagePath"))
    prompt = as_string(data.get("prompt"))
    ref_images = data.get("refImages") or []
    duration = data.get("duration") or 5
    tail_image_path = data.get("tailImagePath")
    shot_id = as_string(data.get("shotId")) or None

    async with _db() as db:
        try:
            if await _should_skip(task_id):
                return {}
            await _mark_processing(db, task_id)
            await db.commit()

            video = get_video()

            # 恢复场景：已有 providerTaskId 则直接轮询
            task = (await db.execute(_select_task(task_id))).scalar_one_or_none()
            provider_task_id = task.provider_task_id if task else None

            if not provider_task_id:
                submit_handle = await video.submit(
                    {
                        "imagePath": image_path,
                        "prompt": prompt,
                        "refImages": ref_images,
                        "duration": duration,
                        "tailImagePath": tail_image_path,
                    }
                )
                if submit_handle.status == "done" and submit_handle.result:
                    # 同步型 provider（mock）：直接完成
                    video_path = submit_handle.result.get("videoPath")
                    _qc_or_warn(video_path)
                    if shot_id:
                        await db.execute(
                            _update_shot(
                                shot_id,
                                video_path=video_path,
                                status="VIDEO_DONE",
                            )
                        )
                    await record_cost(db, task_id, kind="video", count=1)
                    await _mark_done(db, task_id)
                    await db.commit()
                    logger.info("[video] 任务 %s 完成 path=%s", task_id, video_path)
                    return {"videoPath": video_path}
                if submit_handle.status == "failed":
                    await _mark_failed(
                        db, task_id, submit_handle.error or "视频提交失败"
                    )
                    await db.commit()
                    raise RuntimeError(submit_handle.error or "视频提交失败")
                provider_task_id = submit_handle.provider_task_id
                if not provider_task_id:
                    await _mark_failed(db, task_id, "视频任务缺少 providerTaskId")
                    await db.commit()
                    raise RuntimeError("视频任务缺少 providerTaskId")
                # 保存平台任务 ID（供 UI 展示 / 重启恢复）
                await db.execute(
                    _update_task(task_id, provider_task_id=provider_task_id)
                )
                await db.commit()

            # 轮询（最长 ~20 分钟）
            import asyncio

            elapsed = 0
            while elapsed < _VIDEO_POLL_MAX_SEC:
                if await get_pipeline_paused(db):
                    await db.execute(
                        _update_task(
                            task_id,
                            status="PAUSED",
                            error="轮询期间流水线被暂停",
                        )
                    )
                    await db.commit()
                    logger.warning(
                        "[video] 轮询期间流水线被暂停，任务 %s 已暂停", task_id
                    )
                    return {"paused": True, "providerTaskId": provider_task_id}
                await asyncio.sleep(_VIDEO_POLL_INTERVAL_SEC)
                elapsed += _VIDEO_POLL_INTERVAL_SEC
                handle = await video.get_task(provider_task_id)
                if handle.status == "done":
                    video_path = (handle.result or {}).get("videoPath")
                    _qc_or_warn(video_path)
                    if shot_id:
                        await db.execute(
                            _update_shot(
                                shot_id,
                                video_path=video_path,
                                status="VIDEO_DONE",
                            )
                        )
                    await record_cost(db, task_id, kind="video", count=1)
                    await _mark_done(db, task_id)
                    await db.commit()
                    logger.info("[video] 任务 %s 完成 path=%s", task_id, video_path)
                    return {"videoPath": video_path}
                if handle.status == "failed":
                    if shot_id:
                        await db.execute(_update_shot(shot_id, status="VIDEO_FAILED"))
                    await _mark_failed(db, task_id, handle.error or "视频生成失败")
                    await db.commit()
                    raise RuntimeError(handle.error or "视频生成失败")
            if shot_id:
                await db.execute(_update_shot(shot_id, status="VIDEO_FAILED"))
            await _mark_failed(db, task_id, "视频生成超时（20分钟）")
            await db.commit()
            raise RuntimeError("视频生成超时（20分钟）")
        except Exception as e:
            logger.exception("[video] 任务 %s 未捕获异常: %s", task_id, e)
            # 限流/队列满/瞬态网络：自动延迟重入队（与 image 一致），不落 FAILED
            retry_n = int(data.get("_retryN") or 0)
            if _is_transient_error(e) and retry_n < _RATE_LIMIT_MAX_RETRY:
                delay = min(60 * (retry_n + 1), 300)
                _requeue_self("video", data, retry_n + 1, delay)
                try:
                    # 保持 PROCESSING + 写入语义化等待文案（前端显示"限流等待重试 第N次"）；
                    # 刷新 updated_at 防止被 recover_stuck_tasks 误判卡死
                    await db.execute(
                        _update_task(
                            task_id,
                            updated_at=datetime.now(timezone.utc),
                            error=f"限流等待重试（第{retry_n + 1}次），约 {delay} 秒后重试",
                        )
                    )
                    await db.commit()
                except Exception as ce:
                    logger.warning("[video] 限流重入队写库异常: %s", ce)
                logger.warning(
                    "[video] 任务 %s 限流，%ds 后第%d次重试",
                    task_id,
                    delay,
                    retry_n + 1,
                )
                return {"rateLimited": True, "retry": retry_n + 1}
            # 兜底：外层异常也要标记 FAILED，否则任务永久卡在 PROCESSING
            try:
                if shot_id:
                    await db.execute(_update_shot(shot_id, status="VIDEO_FAILED"))
                await _mark_failed(db, task_id, _fmt_error("视频生成", e))
                await db.commit()
            except Exception as ce:
                logger.warning("[video] 标记失败状态异常: %s", ce)
            raise


def _qc_or_warn(video_path: str | None) -> None:
    """视频 QC：WARN 记日志，FAIL 抛错（触发队列重试）"""
    if not video_path:
        return
    from app.quality import qc_video

    r = qc_video(video_path)
    for w in r.get("warnings", []):
        logger.warning("[qc:video] WARN %s: %s", video_path, w)
    if not r.get("ok"):
        msg = f"QC 未通过: {'; '.join(r.get('errors', []))}"
        logger.error("[qc:video] FAIL %s: %s", video_path, msg)
        raise RuntimeError(msg)
    logger.info("[qc:video] PASS %s", video_path)


@celery_app.task(name="workers.tasks.video_task")
def video_task(data: dict[str, Any]) -> dict[str, Any]:
    """video 队列：图生视频（Agnes 异步提交 + 轮询）"""
    from app.core.database import run_async

    try:
        return run_async(_video_handler(data))
    finally:
        # 逐集串行推进：任务落定（成功/失败）后续跑同集链路或停住
        try:
            run_async(_settle_after(data))
        except Exception as se:  # noqa: BLE001 —— 推进失败不影响任务结果
            logger.warning("[video] 逐集推进钩子异常: %s", se)


async def _settle_after(data: dict[str, Any]) -> None:
    """根据 payload 解析任务归属，调用 production 落定钩子"""
    from app.core.database import SessionLocal
    from app.production import settle_shot_step, settle_compose_step

    shot_id = as_string(data.get("shotId")) or None
    episode_id = as_string(data.get("episodeId")) or None
    async with SessionLocal() as db:
        if shot_id:
            await settle_shot_step(db, shot_id)
            await db.commit()
        elif episode_id:
            await settle_compose_step(db, episode_id)
            await db.commit()


# ========== audio 任务 ==========


async def _audio_handler(data: dict[str, Any]) -> dict[str, Any]:
    from app.providers.registry import get_tts
    from app.subtitles import estimate_subtitles, probe_audio_duration
    from app.cost import record_cost

    task_id = data["taskId"]
    text = as_string(data.get("text"))
    voice_id = data.get("voiceId")
    emotion = data.get("emotion")
    rate = data.get("rate")
    sample_rate = data.get("sampleRate")
    shot_id = as_string(data.get("shotId")) or None

    async with _db() as db:
        try:
            if await _should_skip(task_id):
                return {}
            await _mark_processing(db, task_id)
            await db.commit()

            try:
                tts = get_tts()
                handle = await tts.synthesize(
                    {
                        "text": text,
                        "voiceId": voice_id,
                        "emotion": emotion,
                        "rate": rate,
                        "sampleRate": sample_rate,
                    }
                )
                if handle.status == "failed":
                    raise RuntimeError(handle.error or "TTS 合成失败")
                audio_path = (handle.result or {}).get("audioPath")
                result: dict[str, Any] = {"audioPath": audio_path}

                # 字幕兜底：provider 未返回逐句时间戳时，按真实音频时长估算
                subtitles = (handle.result or {}).get("subtitles")
                if not subtitles and audio_path:
                    try:
                        dur = probe_audio_duration(audio_path)
                        subtitles = estimate_subtitles(text, dur)
                        result["subtitles"] = subtitles
                    except Exception as e:
                        logger.warning("[worker] 字幕估算失败: %s", e)

                # 分镜配音 → 回写 Shot
                if shot_id and audio_path:
                    # 字幕存为独立 JSON 文件（列 subtitle_path 是 VARCHAR(500)，
                    # 直接塞 json.dumps(subtitles) 会超长报错并 abort 整个事务）
                    sub_rel: str | None = None
                    if subtitles:
                        from app.storage import save_file

                        sub_rel = save_file(
                            "subs",
                            json.dumps(subtitles, ensure_ascii=False),
                            ".json",
                        )
                    await db.execute(
                        _update_shot(
                            shot_id,
                            voice_path=audio_path,
                            subtitle_path=sub_rel,
                            status="VOICE_DONE",
                        )
                    )
                # 费用估算：按真实音频时长
                if audio_path:
                    try:
                        dur = probe_audio_duration(audio_path)
                        await record_cost(
                            db, task_id, kind="audio", duration_sec=int(dur)
                        )
                    except Exception as e:
                        logger.warning("[worker] 音频时长探测失败: %s", e)
                await _mark_done(db, task_id)
                await db.commit()
                logger.info("[audio] 任务 %s 完成 path=%s", task_id, audio_path)
                return result
            except Exception as e:
                # 前面的 db.execute 可能已 abort 事务，先 rollback 再标记失败，
                # 否则 UPDATE shots/GenTask 都会报 "current transaction is aborted"
                try:
                    await db.rollback()
                except Exception:
                    pass
                try:
                    if shot_id:
                        await db.execute(_update_shot(shot_id, status="VOICE_FAILED"))
                    await _mark_failed(db, task_id, _fmt_error("配音", e))
                    await db.commit()
                except Exception as ce:
                    logger.warning("[audio] 标记失败状态异常: %s", ce)
                logger.warning("[audio] 任务 %s 失败: %s", task_id, e)
                raise
        except Exception as e:
            logger.exception("[audio] 任务 %s 未捕获异常: %s", task_id, e)
            raise


@celery_app.task(name="workers.tasks.audio_task")
def audio_task(data: dict[str, Any]) -> dict[str, Any]:
    """audio 队列：TTS 配音 + 字幕估算"""
    from app.core.database import run_async

    try:
        return run_async(_audio_handler(data))
    finally:
        try:
            run_async(_settle_after(data))
        except Exception as se:  # noqa: BLE001
            logger.warning("[audio] 逐集推进钩子异常: %s", se)


# ========== compose 任务 ==========


async def _compose_handler(data: dict[str, Any]) -> dict[str, Any]:
    from app.compose.index import compose_episode
    from app.cost import record_cost

    task_id = data["taskId"]
    episode_id = data.get("episodeId")
    bgm_mood = data.get("bgmMood")
    if not episode_id:
        raise ValueError("缺少 episodeId")

    async with _db() as db:
        try:
            if await _should_skip(task_id):
                return {}
            await _mark_processing(db, task_id)
            await db.commit()

            episode = (
                await db.execute(_select_episode(episode_id))
            ).scalar_one_or_none()
            if not episode:
                raise ValueError(f"剧集不存在: {episode_id}")
            result = await compose_episode(db, episode, bgm_mood)
            await record_cost(db, task_id, kind="compose")
            await _mark_done(db, task_id)
            await db.commit()
            logger.info("[compose] 任务 %s 完成", task_id)
            return result
        except Exception as e:
            # 任务失败：标记 GenTask FAILED（持久化），不阻塞 Celery 自身重试/记录
            logger.exception("[compose] 任务 %s 失败: %s", task_id, e)
            try:
                await _mark_failed(db, task_id, _fmt_error("合成", e))
                # Episode 置 failed：流水线停住待人工重试（不再回到 draft）
                if episode_id:
                    await db.execute(_update_episode(episode_id, status="failed"))
                await db.commit()
            except Exception as ce:
                logger.warning("[compose] 标记失败状态异常: %s", ce)
            raise


def _select_episode(eid):
    from sqlalchemy import select

    return select(Episode).where(Episode.id == eid)


def _update_episode(eid: str, **values):
    from sqlalchemy import update

    return update(Episode).where(Episode.id == eid).values(**values)


@celery_app.task(name="workers.tasks.compose_task")
def compose_task(data: dict[str, Any]) -> dict[str, Any]:
    """compose 队列：ffmpeg 最终合成"""
    from app.core.database import run_async

    try:
        return run_async(_compose_handler(data))
    finally:
        try:
            run_async(_settle_after(data))
        except Exception as se:  # noqa: BLE001
            logger.warning("[compose] 逐集推进钩子异常: %s", se)


# ========== 任务注册（供 Celery worker 进程显式导入） ==========

# autodiscover_tasks(["workers"]) 会导入本模块；这里再显式列出，
# 确保 workers 进程以 "celery -A app.core.celery_app worker -Q ..." 启动时任务已注册。
__all__ = [
    "script_task",
    "image_task",
    "video_task",
    "audio_task",
    "compose_task",
]
