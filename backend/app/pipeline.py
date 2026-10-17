"""流水线全局控制（持久化）

目的：程序（Worker）重启后默认暂停，不自动消费 Redis 中遗留的历史任务。
用户点击「继续执行」后才恢复消费。
存储：PipelineControl 单行表（id 恒为 1），paused 默认 true。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PipelineControl


async def get_pipeline_paused(db: AsyncSession) -> bool:
    """读取当前暂停状态；无记录时视为暂停（首次启动默认暂停）"""
    try:
        row = (
            await db.execute(select(PipelineControl).where(PipelineControl.id == 1))
        ).scalar_one_or_none()
        return row.paused if row else True
    except Exception:
        return True


async def set_pipeline_paused(db: AsyncSession, paused: bool) -> bool:
    """写入暂停状态（持久化，重启后保持）"""
    row = (
        await db.execute(select(PipelineControl).where(PipelineControl.id == 1))
    ).scalar_one_or_none()
    if row:
        row.paused = paused
    else:
        db.add(PipelineControl(id=1, paused=paused))
    await db.flush()
    return paused
