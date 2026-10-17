"""供应商配置中心

设计原则：
- 配置按「能力类别」分组：text / image / video / tts，每类只读自己的 `<类别>.*` 配置
- 配置键 `<类别>.<字段>` 与环境变量 `<大写类别>_<大写字段>` 一一对应
- 读取优先级：DB (ProviderSetting) > 环境变量 > 默认值
- 设置页写入 DB；Key 类敏感信息仅存 DB + env
"""

from __future__ import annotations

import re
import time
from typing import Any

from app.core.config import get_settings, AGNES_BASE
from app.core.database import get_session

# 小米 MiMo-TTS 官方 Base URL（免费额度直连）
MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"

# ========== 默认配置 ==========
DEFAULTS: dict[str, str] = {
    "mock.mode": "auto",
    # 文本（LLM）— Agnes 全家桶默认 + OpenAI 兼容（TEXT_PROVIDER=openai 走 OpenCode Zen）
    "text.provider": "agnes",
    "text.model": "agnes-3.0-flash",
    "text.baseUrl": AGNES_BASE,
    # 图像
    "image.provider": "agnes",
    "image.model": "agnes-image-2.5-flash",
    "image.baseUrl": AGNES_BASE,
    # 视频
    "video.provider": "agnes",
    "video.model": "agnes-video-2.5-flash",
    "video.baseUrl": AGNES_BASE,
    # TTS（默认小米 MiMo-TTS 官方免费额度；未配置 Key 时自动 Mock）
    "tts.engine": "mimo",
    "tts.model": "mimo-v2.5-tts",
    "tts.voice": "",
    "tts.baseUrl": MIMO_BASE_URL,
}


# 配置键 → 环境变量名：text.apiKey → TEXT_API_KEY
def setting_key_to_env(key: str) -> str:
    s = key.replace(".", "_")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    return s.upper()


# ========== 缓存 ==========
_cache: dict[str, str] = {}
_cache_loaded = False
_cache_loaded_at = 0.0
_CACHE_TTL = 60.0  # 秒


def invalidate_cache() -> None:
    global _cache_loaded, _cache_loaded_at
    _cache_loaded = False
    _cache_loaded_at = 0.0
    _cache.clear()


def _load_from_env() -> None:
    """从环境变量加载（DB 不可用时的兜底）"""
    s = get_settings()
    mapping = {
        "mock.mode": s.mock_mode,
        "text.provider": s.text_provider,
        "text.model": s.text_model,
        "text.baseUrl": s.text_base_url,
        "text.apiKey": s.text_api_key,
        "image.provider": s.image_provider,
        "image.model": s.image_model,
        "image.baseUrl": s.image_base_url,
        "image.apiKey": s.image_api_key,
        "video.provider": s.video_provider,
        "video.model": s.video_model,
        "video.baseUrl": s.video_base_url,
        "video.apiKey": s.video_api_key,
        "tts.engine": s.tts_engine,
        "tts.model": s.tts_model,
        "tts.voice": s.tts_voice,
        "tts.baseUrl": s.tts_base_url,
        "tts.apiKey": s.tts_api_key,
    }
    for k, v in mapping.items():
        if v:
            _cache.setdefault(k, v)


def _env_or_default(key: str) -> str | None:
    s = get_settings()
    env_keys: dict[str, Any] = {
        "mock.mode": s.mock_mode,
        "text.provider": s.text_provider,
        "text.model": s.text_model,
        "text.baseUrl": s.text_base_url,
        "text.apiKey": s.text_api_key,
        "image.provider": s.image_provider,
        "image.model": s.image_model,
        "image.baseUrl": s.image_base_url,
        "image.apiKey": s.image_api_key,
        "video.provider": s.video_provider,
        "video.model": s.video_model,
        "video.baseUrl": s.video_base_url,
        "video.apiKey": s.video_api_key,
        "tts.engine": s.tts_engine,
        "tts.model": s.tts_model,
        "tts.voice": s.tts_voice,
        "tts.baseUrl": s.tts_base_url,
        "tts.apiKey": s.tts_api_key,
    }
    v = env_keys.get(key)
    if v:
        return v
    return DEFAULTS.get(key)


def get_setting_sync(key: str) -> str | None:
    """同步读取（env + 默认，不查 DB；用于无 DB 依赖场景）"""
    v = _env_or_default(key)
    if v is not None:
        return v
    return None


def set_setting_sync(key: str, value: str) -> None:
    """写入进程级缓存（设置页保存后调用，立即生效）"""
    if value:
        _cache[key] = value
    else:
        _cache.pop(key, None)


def get_setting_from_cache(key: str) -> str | None:
    if key in _cache:
        return _cache[key]
    return _env_or_default(key)


def mask_key(key: str | None) -> str:
    """脱敏 API Key（保留首尾各 4 位，过短则全掩码）"""
    if not key:
        return "(未配置)"
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}****{key[-4:]}"


# ========== 分类配置读取助手（同步版，供 Celery worker 与 provider 使用） ==========


def get_text_config() -> dict:
    return {
        "provider": get_setting_sync("text.provider") or "agnes",
        "apiKey": get_setting_sync("text.apiKey"),
        "model": get_setting_sync("text.model") or "agnes-3.0-flash",
        "baseUrl": get_setting_sync("text.baseUrl") or AGNES_BASE,
    }


def get_image_config() -> dict:
    return {
        "provider": get_setting_sync("image.provider") or "agnes",
        "apiKey": get_setting_sync("image.apiKey"),
        "model": get_setting_sync("image.model") or "agnes-image-2.5-flash",
        "baseUrl": get_setting_sync("image.baseUrl") or AGNES_BASE,
    }


def get_video_config() -> dict:
    return {
        "provider": get_setting_sync("video.provider") or "agnes",
        "apiKey": get_setting_sync("video.apiKey"),
        "model": get_setting_sync("video.model") or "agnes-video-2.5-flash",
        "baseUrl": get_setting_sync("video.baseUrl") or AGNES_BASE,
    }


def get_tts_config() -> dict:
    return {
        "engine": get_setting_sync("tts.engine") or "",
        "apiKey": get_setting_sync("tts.apiKey"),
        "model": get_setting_sync("tts.model"),
        "voice": get_setting_sync("tts.voice"),
        "baseUrl": get_setting_sync("tts.baseUrl"),
    }


# ========== Mock 判定（与 Node 端 shouldUseMock 对齐） ==========


def should_use_mock(category: str) -> bool:
    """category: text | image | video | tts"""
    mode = get_setting_sync("mock.mode") or "auto"
    if mode == "true":
        return True
    if mode == "false":
        return False
    # auto：依据各类自身凭证判定
    if category == "tts":
        engine = get_setting_sync("tts.engine") or ""
        if not engine:
            return True
        if engine == "edge-tts":
            return False
        return not (get_setting_sync("tts.apiKey") or "")
    key = get_setting_sync(f"{category}.apiKey")
    return not key


async def get_setting_async(key: str, session=None) -> str | None:
    """异步读取 DB 配置（FastAPI 路由中使用）"""
    from sqlalchemy import select
    from app.models import ProviderSetting
    from app.core.database import SessionLocal

    async with session or SessionLocal() as s:
        row = (
            await s.execute(select(ProviderSetting).where(ProviderSetting.key == key))
        ).scalar_one_or_none()
        if row:
            return row.value
    return get_setting_sync(key)


async def all_settings_async() -> dict[str, str]:
    """获取全部配置（DB > env > 默认，设置页展示用）"""
    from sqlalchemy import select
    from app.models import ProviderSetting
    from app.core.database import SessionLocal

    async with SessionLocal() as s:
        rows = (await s.execute(select(ProviderSetting))).scalars().all()
    result: dict[str, str] = {}
    for row in rows:
        result[row.key] = row.value
    for k, v in DEFAULTS.items():
        result.setdefault(k, v)
    # 补充环境变量中的 Key（DB 未设置时）
    s2 = get_settings()
    result.setdefault("text.apiKey", s2.text_api_key)
    result.setdefault("image.apiKey", s2.image_api_key)
    result.setdefault("video.apiKey", s2.video_api_key)
    result.setdefault("tts.apiKey", s2.tts_api_key)
    return result


async def upsert_setting_async(key: str, value: str) -> None:
    """设置页写 DB"""
    from sqlalchemy import select
    from app.models import ProviderSetting
    from app.core.database import SessionLocal

    async with SessionLocal() as s:
        row = (
            await s.execute(select(ProviderSetting).where(ProviderSetting.key == key))
        ).scalar_one_or_none()
        if value:
            if row:
                row.value = value
            else:
                s.add(ProviderSetting(key=key, value=value))
        else:
            if row:
                await s.delete(row)
        await s.commit()
    set_setting_sync(key, value)
