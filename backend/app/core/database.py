"""SQLAlchemy 2.0 async 数据库会话管理（FastAPI 依赖注入 + Celery worker 辅助）"""

from __future__ import annotations

import asyncio
import concurrent.futures
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from app.core.config import get_settings

_settings = get_settings()

# 异步引擎（FastAPI 应用生命周期内复用）
engine: AsyncEngine = create_async_engine(
    _settings.database_url,
    pool_size=20,
    max_overflow=10,
    pool_timeout=5.0,
    pool_recycle=300,
    pool_pre_ping=True,
    echo=False,
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


@asynccontextmanager
async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 依赖：每个请求独立会话，自动提交/回滚"""
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """get_session 的别名（与 FastAPI Depends 兼容）"""
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def close_db() -> None:
    await engine.dispose()


# ========== Celery worker 同步适配 ==========
from sqlalchemy.pool import NullPool


def run_async(coro):
    """在 Celery worker 同步上下文中运行异步协程。

    每次调用创建 NullPool 引擎（无连接池缓存），随 asyncio.run 一起
    生命周期结束：连接在协程内创建、在协程内关闭，永不跨事件循环复用，
    彻底消除 "attached to a different loop"。
    """
    local_engine = create_async_engine(
        _settings.database_url,
        poolclass=NullPool,
        echo=False,
    )
    local_sm = async_sessionmaker(
        local_engine, expire_on_commit=False, class_=AsyncSession
    )

    global SessionLocal
    orig = SessionLocal
    SessionLocal = local_sm
    try:
        return asyncio.run(coro)
    finally:
        SessionLocal = orig
