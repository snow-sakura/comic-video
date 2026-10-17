"""Redis 连接管理（用于 Celery 任务状态查询 / 流水线控制标志）"""

from __future__ import annotations

import redis.asyncio as aioredis

from app.core.config import get_settings

_pool: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _pool
    if _pool is None:
        s = get_settings()
        _pool = aioredis.from_url(s.redis_url, decode_responses=True)
    return _pool


async def init_redis() -> None:
    await get_redis().ping()


async def close_redis() -> None:
    global _pool
    if _pool:
        await _pool.aclose()
        _pool = None
