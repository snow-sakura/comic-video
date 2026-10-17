"""供应商注册表 — 按配置路由到真实/Mock 实现（与 Node 端 registry.ts 对齐）"""

from __future__ import annotations

from typing import Callable

from app.providers.settings import get_setting_sync, should_use_mock
from app.providers.text import (
    create_agnes_text,
    create_openai_compat_text,
    create_mock_llm,
)
from app.providers.image import create_agnes_image, create_mock_image
from app.providers.video import create_agnes_video, create_mock_video
from app.providers.tts import (
    create_edge_tts,
    create_mock_tts,
    create_openai_compat_tts,
    create_tokendance_tts,
)
from app.providers.base import LLMProvider, ImageProvider, VideoProvider, TTSProvider

# ========== 实例缓存 ==========
_cache: dict[str, object] = {}


def reset_provider_cache() -> None:
    _cache.clear()


def _cached(
    key: str,
    factory: Callable[[], LLMProvider | ImageProvider | VideoProvider | TTSProvider],
):
    """实例缓存（按 key 复用同一 provider 实例，避免重复构造）"""
    if key not in _cache:
        _cache[key] = factory()
    return _cache[key]


# ========== 文本（LLM） ==========


def get_text_llm() -> LLMProvider:
    """文本模型（默认 Agnes；按 text.provider 选择后端）

    - agnes   → Agnes AI 文本全家桶（OpenAI 兼容）
    - openai  → 通用 OpenAI 兼容端点（OpenCode Zen 等，baseUrl/key 由配置提供）
    - mock    → Mock（无 Key 演示）
    """

    def factory() -> LLMProvider:
        provider = get_setting_sync("text.provider") or "agnes"
        if provider == "mock":
            return create_mock_llm()
        if should_use_mock("text"):
            return create_mock_llm()
        if provider == "openai":
            return create_openai_compat_text()
        return create_agnes_text()

    return _cached("llm", factory)


get_script_llm = get_text_llm
get_struct_llm = get_text_llm


# ========== 图像 ==========


def get_image() -> ImageProvider:
    def factory() -> ImageProvider:
        provider = get_setting_sync("image.provider") or "agnes"
        if provider == "mock":
            return create_mock_image()
        if should_use_mock("image"):
            return create_mock_image()
        return create_agnes_image()

    return _cached("image", factory)


# ========== 视频 ==========


def get_video() -> VideoProvider:
    def factory() -> VideoProvider:
        provider = get_setting_sync("video.provider") or "agnes"
        if provider == "mock":
            return create_mock_video()
        if should_use_mock("video"):
            return create_mock_video()
        return create_agnes_video()

    return _cached("video", factory)


# ========== TTS ==========


def get_tts() -> TTSProvider:
    def factory() -> TTSProvider:
        engine = get_setting_sync("tts.engine") or ""
        if not engine or engine == "mock":
            return create_mock_tts()
        if should_use_mock("tts"):
            return create_mock_tts()
        if engine == "edge-tts":
            return create_edge_tts()
        if engine == "mimo":
            # 小米 MiMo-TTS（OpenAI 兼容 /v1/audio/speech；官方免费额度；也可指向 TokenDance 等网关）
            return create_openai_compat_tts()
        if engine == "tokendance":
            # TokenDance 音频网关（小米/MiniMax/豆包；充值额度制）
            return create_tokendance_tts()
        # confucius4 / voxcpm 等未实现 → Mock 兜底
        return create_mock_tts()

    return _cached("tts", factory)
