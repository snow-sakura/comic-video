"""调度档位与 worker 进程组计划 — 免费模型单任务串行 / 付费模型多进程并行

物理队列（见 app/core/celery_app.py 的 QUEUE_NAMES）：

    script.free | script.paid
    image.free  | image.paid
    video.free  | video.paid
    audio.free  | audio.paid
    compose     （本地 ffmpeg，恒串行）

档位判定（D1）：
- 环境变量 `SCHED_TIER=free|paid` 强制覆盖（测试与兜底）优先级最高
- 否则按当前**生效模型**在 providers/catalog 的 tags（含 paid → 付费档）
  · script → text.model ；image → image.model ；video → video.model
  · audio → tts.engine（tokendance 网关按量计费=付费，其余免费）
  · compose → 恒免费（本地 CPU，串行避免争抢）

并发（D4，仅付费档生效）：
- 环境变量 `WORKER_CONCURRENCY_<KIND>_PAID` 覆盖
- 默认 {script: 2, image: 4, video: 3, audio: 4}

worker 进程组（D2）：
- free 组：1 个 solo 进程，消费 script.free/image.free/video.free/audio.free + compose
- paid 组：每个"当前为付费档"的能力单独一个 prefork 进程（-c 并发数）

为什么并行必须用进程而非线程：`app.core.database.run_async` 通过改写模块级
`SessionLocal` 切换事件循环绑定，多线程并发会互相踩踏，必须进程隔离。
"""

from __future__ import annotations

import os
from typing import Literal

from app.providers.catalog import get_model_tier
from app.providers.settings import (
    get_image_config,
    get_text_config,
    get_tts_config,
    get_video_config,
)

Tier = Literal["free", "paid"]

FREE: Tier = "free"
PAID: Tier = "paid"

# 需要按档位拆分队列的能力（compose 不拆）
KINDS: tuple[str, ...] = ("script", "image", "video", "audio")

# 免费档恒为串行消费的队列组（含本地 compose）
FREE_QUEUES: tuple[str, ...] = tuple(f"{k}.free" for k in KINDS) + ("compose",)

# 付费档默认并发
PAID_DEFAULT: dict[str, int] = {
    "script": 2,
    "image": 4,
    "video": 3,
    "audio": 4,
}

# 免费 TTS 引擎（空串=Mock）；tokendance 为按量计费网关
_FREE_TTS_ENGINES: frozenset[str] = frozenset(
    {"", "edge-tts", "mimo", "confucius4", "voxcpm"}
)


def _forced_tier() -> Tier | None:
    v = (os.environ.get("SCHED_TIER") or "").strip().lower()
    if v in ("free", "paid"):
        return v  # type: ignore[return-value]
    return None


def _current_model(kind: str) -> str:
    if kind == "script":
        return get_text_config().get("model") or ""
    if kind == "image":
        return get_image_config().get("model") or ""
    if kind == "video":
        return get_video_config().get("model") or ""
    return ""


_KIND_CATEGORY: dict[str, str] = {
    "script": "text",
    "image": "image",
    "video": "video",
}


def get_tier(kind: str) -> Tier:
    """某能力当前所属档位（free=单任务串行 / paid=多进程并行）"""
    forced = _forced_tier()
    if forced:
        return forced
    if kind == "compose":
        return FREE
    if kind == "audio":
        engine = (get_tts_config().get("engine") or "").strip()
        return FREE if engine in _FREE_TTS_ENGINES else PAID
    category = _KIND_CATEGORY.get(kind)
    if not category:
        return FREE
    model = _current_model(kind)
    return PAID if get_model_tier(category, model) == "paid" else FREE


def get_tiers() -> dict[str, Tier]:
    return {k: get_tier(k) for k in KINDS}


def get_paid_concurrency(kind: str) -> int:
    raw = os.environ.get(f"WORKER_CONCURRENCY_{kind.upper()}_PAID")
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except ValueError:
            pass
    return PAID_DEFAULT.get(kind, 3)


def get_worker_groups() -> list[dict]:
    """worker 进程组计划：供启动脚本按组拉起。

    每项：{name, queues, concurrency, pool}
    """
    groups: list[dict] = [
        {
            "name": "free",
            "queues": list(FREE_QUEUES),
            "concurrency": 1,
            "pool": "solo",
        }
    ]
    for kind in KINDS:
        if get_tier(kind) == PAID:
            groups.append(
                {
                    "name": f"{kind}-paid",
                    "queues": [f"{kind}.paid"],
                    "concurrency": get_paid_concurrency(kind),
                    "pool": "prefork",
                }
            )
    return groups


def get_status() -> dict:
    """前端 / API 展示用：档位、进程组、进程总数"""
    tiers = get_tiers()
    groups = get_worker_groups()
    return {
        "forced": _forced_tier(),
        "tiers": tiers,
        "groups": groups,
        "totalWorkers": sum(g["concurrency"] for g in groups),
        "parallel": any(g["concurrency"] > 1 for g in groups),
    }
