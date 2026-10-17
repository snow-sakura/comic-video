"""设置页路由 — /api/settings

GET /api/settings — 读取全部供应商配置（Key 脱敏）
PUT /api/settings — 保存配置（空值删除）
"""

from __future__ import annotations

import json
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from app.core.database import get_db
from app.providers.settings import (
    all_settings_async,
    upsert_setting_async,
    invalidate_cache,
    setting_key_to_env,
)
from app.providers.registry import reset_provider_cache

router = APIRouter()

SENSITIVE_KEYS = ["apiKey", "secret", "token", "password"]


def _mask_value(key: str, value: str) -> str:
    if not any(s in key for s in SENSITIVE_KEYS):
        return value
    if not value:
        return ""
    if len(value) <= 4:
        return "****"
    return f"{value[:2]}****{value[-2:]}"


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)):
    try:
        all_ = await all_settings_async()
        masked = {k: _mask_value(k, v) for k, v in all_.items()}
        return {"settings": masked}
    except Exception as e:
        raise HTTPException(500, f"读取设置失败: {e}")


@router.put("/settings")
async def put_settings(req: Request, db: AsyncSession = Depends(get_db)):
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "JSON 解析失败")
    settings = body.get("settings")
    sync_env = body.get("syncEnv")
    if not isinstance(settings, dict):
        raise HTTPException(400, "参数错误")

    env_local_updates: dict[str, str] = {}

    for key, value in settings.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise HTTPException(400, "参数错误")
        v = value.strip()
        await upsert_setting_async(key, v)
        if sync_env and v:
            # 同步写回环境变量（供本进程使用）
            import os

            env_key = setting_key_to_env(key)
            os.environ[env_key] = v
            env_local_updates[env_key] = v

    if sync_env and env_local_updates:
        _write_env_local(env_local_updates)

    invalidate_cache()
    reset_provider_cache()
    return {"ok": True, "syncedEnv": sync_env is True}


def _write_env_local(updates: dict[str, str]) -> None:
    """把键值合并写入 backend/.env.local（键已转换为大写环境变量名）"""
    from pathlib import Path

    from app.core.config import SERVER_ROOT

    path = Path(SERVER_ROOT) / ".env.local"
    existing: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, _, val = s.partition("=")
            existing[k.strip()] = val
    existing.update(updates)
    body = "\n".join(f"{k}={v}" for k, v in existing.items())
    path.write_text(body + "\n", encoding="utf-8")
