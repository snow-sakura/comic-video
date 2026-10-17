"""模型目录路由 — /api/models

GET /api/models — 返回 AI 模型预设目录 + 当前生效配置（非敏感）+ 出厂默认
前端设置页据此渲染供应商/模型下拉框；用户选择保存仍走 PUT /api/settings → provider_settings
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.providers.catalog import get_catalog
from app.providers.settings import all_settings_async

router = APIRouter()

# 与 GET /api/settings 相同的脱敏规则（不回传真实 Key）
_SENSITIVE = ("apiKey", "secret", "token", "password")

# 每个能力对应的配置键
_CATEGORY_KEYS = {
    "text": ("text.provider", "text.model", "text.baseUrl", "text.apiKey"),
    "image": ("image.provider", "image.model", "image.baseUrl", "image.apiKey"),
    "video": ("video.provider", "video.model", "video.baseUrl", "video.apiKey"),
    "tts": ("tts.engine", "tts.model", "tts.voice", "tts.baseUrl", "tts.apiKey"),
}


def _mask(key: str, value: str) -> str:
    if not any(s in key for s in _SENSITIVE):
        return value
    if not value:
        return ""
    if len(value) <= 4:
        return "****"
    return f"{value[:2]}****{value[-2:]}"


@router.get("/models")
async def list_models(db: AsyncSession = Depends(get_db)):
    catalog = get_catalog()
    try:
        all_ = await all_settings_async()
    except Exception:
        all_ = {}

    current: dict[str, dict[str, str]] = {}
    for cat, keys in _CATEGORY_KEYS.items():
        current[cat] = {k: _mask(k, all_.get(k, "") or "") for k in keys}

    return {
        "catalog": catalog,
        "current": current,
        "sources": {
            "agnes": "https://agnes-ai.com/zh-Hans/docs/overview",
            "tokendance": "https://tokendance.space/models?output_modality=audio",
            "mimo": "https://mimo.mi.com/docs",
            "voxcpm": "https://voxcpm.readthedocs.io/zh-cn/latest/installation.html",
        },
    }
