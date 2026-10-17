"""费用估算

只做估算展示，不实际扣费。
- 未配置真实 Key（mock provider）一律记 0 元
- LLM 按字符估算 token（中文 1 字 ≈ 1 token，非中文 4 字符 ≈ 1 token）
- 图片/视频/语音按行业参考单价计次（估算值，仅用于展示）
"""

from __future__ import annotations

import math

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import GenTask
from app.providers.settings import get_setting_sync


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = 0
    other = 0
    for ch in text:
        cp = ord(ch)
        if 0x3000 <= cp <= 0x9FFF or 0xF900 <= cp <= 0xFAFF or 0x20000 <= cp <= 0x2FA1F:
            cjk += 1
        else:
            other += 1
    return math.ceil(cjk + other / 4)


# 单价（元 / 千 token，参考价，仅估算）
LLM_PRICES: dict[str, dict[str, float]] = {
    "agnes": {"input": 0.002, "output": 0.008},
    "glm": {"input": 0.0, "output": 0.0},
    "deepseek": {"input": 0.002, "output": 0.008},
    "doubao": {"input": 0.002, "output": 0.008},
}
IMAGE_PRICE = 0.15
VIDEO_PRICE = 2.0
AUDIO_PRICE_PER_MIN = 0.5


def _is_mock(kind: str) -> bool:
    key = {
        "llm": "text.provider",
        "image": "image.provider",
        "video": "video.provider",
        "audio": "tts.engine",
    }.get(kind, "")
    pid = (get_setting_sync(key) or "").lower()
    return pid == "" or "mock" in pid


def estimate_cost(
    kind: str,
    *,
    input_chars: int = 0,
    output_chars: int = 0,
    count: int = 0,
    duration_sec: int = 0,
) -> float:
    if _is_mock(kind):
        return 0.0
    if kind == "llm":
        provider = (get_setting_sync("text.provider") or "").lower()
        p = LLM_PRICES.get(provider, LLM_PRICES["glm"])
        input_tokens = estimate_tokens("x" * input_chars) if input_chars else 0
        output_tokens = math.ceil(output_chars / 1.5) if output_chars else 0
        return (input_tokens * p["input"] + output_tokens * p["output"]) / 1000
    if kind == "image":
        return count * IMAGE_PRICE
    if kind == "video":
        return count * VIDEO_PRICE
    if kind == "audio":
        return (duration_sec / 60) * AUDIO_PRICE_PER_MIN
    return 0.0


async def record_cost(
    db: AsyncSession,
    task_id: str,
    *,
    input_chars: int = 0,
    output_chars: int = 0,
    count: int = 0,
    duration_sec: int = 0,
    kind: str = "compose",
) -> None:
    """估算并写入 GenTask.cost（失败静默，不影响任务主流程）"""
    try:
        cost = estimate_cost(
            kind,
            input_chars=input_chars,
            output_chars=output_chars,
            count=count,
            duration_sec=duration_sec,
        )
        await db.execute(update(GenTask).where(GenTask.id == task_id).values(cost=cost))
        await db.flush()
    except Exception:
        pass
