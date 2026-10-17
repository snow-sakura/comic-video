"""Celery 应用与任务入队辅助（替代 BullMQ）

五条队列对应四步流水线 + 合成：
  script  → 剧本工坊（LLM 长任务）
  image   → 分镜/资产出图
  video   → 分镜转视频（Agnes，异步提交+轮询）
  audio   → TTS/音乐/音效
  compose → 最终合成导出（ffmpeg）

并发数可通过环境变量覆盖：WORKER_CONCURRENCY_SCRIPT 等
"""

from __future__ import annotations

import os
from typing import Any

from app.core.celery_app import QUEUE_NAMES, celery_app
from app.core.database import SessionLocal
from app.models import GenTask
from sqlalchemy import update


def get_concurrency(name: str, default: int) -> int:
    env_val = os.environ.get(f"WORKER_CONCURRENCY_{name.upper()}")
    try:
        v = int(env_val) if env_val else 0
        return v if v > 0 else default
    except ValueError:
        return default


_KIND_CATEGORY = {"script": "text", "image": "image", "video": "video"}


def resolve_queue(kind: str, model: str | None = None) -> str:
    """逻辑队列 → 物理队列：script/image/video/audio 按模型档位拆分为
    {kind}.free / {kind}.paid；compose 为单队列。

    - model 传入时按其 catalog tags 判定档位
    - model 缺失时回退到当前生效配置判定（app/scheduler/tier.get_tier）
    免费=串行消费队列；付费=prefork 并行消费队列。
    """
    if kind == "compose":
        return "compose"
    if kind == "audio":
        from app.scheduler.tier import get_tier

        return f"audio.{get_tier('audio')}"
    if kind in _KIND_CATEGORY:
        if model:
            from app.providers.catalog import get_model_tier

            tier = get_model_tier(_KIND_CATEGORY[kind], model)
        else:
            from app.scheduler.tier import get_tier

            tier = get_tier(kind)
        return f"{kind}.{tier}"
    return kind


def _get_db():
    from app.core.database import SessionLocal

    return SessionLocal()


def enqueue_gen_task(
    queue_name: str,
    task_id: str,
    payload: dict[str, Any],
    delay: int = 0,
    job_id: str | None = None,
) -> str:
    """入队并标记 GenTask（幂等：默认 task_id 作为 job_id）

    queue_name 传逻辑队列（script/image/video/audio/compose）；
    script/image/video/audio 会按任务模型档位路由到 .free / .paid 物理队列
    （档位同时写入 payload `_tier`，供限流重入队时保持原通道）。
    入队失败（Redis 不可用）时标记任务 FAILED，避免卡在 QUEUED。
    """
    # 逻辑队列 → 物理队列（script/image/video/audio 按档位拆分；compose 单队列）
    kind = queue_name.split(".")[0]
    physical_queue = (
        queue_name
        if queue_name in set(QUEUE_NAMES.values())
        else resolve_queue(kind, payload.get("model") or payload.get("modelName"))
    )
    tier = "paid" if physical_queue.endswith(".paid") else "free"

    task_name = f"workers.tasks.{kind}_task"
    try:
        job = celery_app.send_task(
            task_name,
            args=[{"taskId": task_id, "_tier": tier, **payload}],
            queue=physical_queue,
            task_id=job_id or task_id,
            countdown=delay,
        )
        return job.id or task_id
    except Exception as e:
        msg = str(e)
        print(f"[enqueue] 入队失败 taskId={task_id} queue={physical_queue}: {msg}")
        db = _get_db()
        try:
            db.execute(
                update(GenTask)
                .where(GenTask.id == task_id)
                .values(status="FAILED", error=f"入队失败: {msg}")
            )
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()
        raise RuntimeError(f"入队失败: {msg}")


def pause_stuck_tasks() -> int:
    """启动前将 PROCESSING/QUEUED 任务标记为 PAUSED（防止 Worker 重启自动重跑旧任务）"""
    db = _get_db()
    try:
        result = db.execute(
            update(GenTask)
            .where(GenTask.status.in_(["PROCESSING", "QUEUED"]))
            .values(status="PAUSED", error="程序重启后任务已暂停，需手动继续执行")
        )
        db.commit()
        n = result.rowcount
        if n > 0:
            print(f"[queue] 已将 {n} 个 PROCESSING/QUEUED 任务转为 PAUSED")
        return n
    except Exception as e:
        db.rollback()
        print(f"[queue] pauseStuckTasks 失败: {e}")
        return 0
    finally:
        db.close()


def drain_queues() -> None:
    """清空所有 Celery 队列中的残留任务（配合 pause_stuck_tasks 使用）"""
    import redis as redis_lib
    from app.core.config import get_settings

    s = get_settings()
    client = redis_lib.Redis.from_url(s.redis_url, decode_responses=True)
    for qname in QUEUE_NAMES.values():
        try:
            llen = client.llen(qname)
            if llen > 0:
                client.delete(qname)
                print(f"[queue:{qname}] 已清空 {llen} 个残留任务")
        except Exception as e:
            print(f"[queue:{qname}] drain 失败: {e}")
    client.close()


# 卡死判定阈值（分钟）：视频任务合法时长可达 20 分钟（轮询上限），故单独放宽
_STALE_MINUTES = {
    "LLM": 30,
    "IMAGE": 20,
    "VIDEO": 45,
    "TTS": 15,
    "COMPOSE": 20,
}
_STALE_DEFAULT_MINUTES = 20


async def recover_stuck_tasks() -> int:
    """把长期停在 QUEUED/PROCESSING 的孤儿任务标记为 FAILED，避免永久锁死项目闸门。

    触发场景：worker 重启丢任务 / 入队竞态 / provider 卡死。
    阈值按任务类型区分（视频轮询合法时长可达 20 分钟）。
    返回处理条数。挂到 API 启动与手动恢复入口。
    """
    from datetime import datetime, timedelta, timezone

    async with SessionLocal() as db:
        try:
            now = datetime.now(timezone.utc)
            rows = (
                (
                    await db.execute(
                        sa_select(GenTask).where(
                            GenTask.status.in_(["QUEUED", "PROCESSING"])
                        )
                    )
                )
                .scalars()
                .all()
            )
            recovered = 0
            for t in rows:
                ttype = (t.type or "").upper()
                minutes = _STALE_MINUTES.get(ttype, _STALE_DEFAULT_MINUTES)
                age_ref = t.updated_at or t.created_at
                if age_ref is None:
                    continue
                if age_ref.tzinfo is None:
                    age_ref = age_ref.replace(tzinfo=timezone.utc)
                age_min = (now - age_ref).total_seconds() / 60
                if age_min < minutes:
                    continue
                await db.execute(
                    update(GenTask)
                    .where(GenTask.id == t.id)
                    .values(
                        status="FAILED",
                        error=f"任务卡死超 {minutes} 分钟（{ttype or '未知类型'}），已自动标记失败，可点击重试",
                    )
                )
                recovered += 1
            if recovered:
                await db.commit()
                print(f"[queue] 已恢复 {recovered} 个卡死任务（标记 FAILED 可重试）")
            return recovered
        except Exception as e:
            await db.rollback()
            print(f"[queue] recover_stuck_tasks 失败: {e}")
            return 0
