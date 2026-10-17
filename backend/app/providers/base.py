"""AI 供应商适配器层 — 统一契约"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator

# ========== 任务句柄 ==========


@dataclass
class TaskHandle:
    task_id: str
    provider_task_id: str | None = None
    status: str = "queued"  # queued | processing | done | failed
    result: dict[str, Any] | None = None
    error: str | None = None


class ProviderError(Exception):
    def __init__(
        self,
        provider: str,
        message: str,
        code: str = "UPSTREAM",
        retryable: bool = True,
    ):
        super().__init__(message)
        self.provider = provider
        self.code = (
            code  # UNAUTHORIZED | RATE_LIMIT | INVALID_REQUEST | TIMEOUT | UPSTREAM
        )
        self.retryable = retryable


# ========== LLM ==========


@dataclass
class LLMOptions:
    json: bool = False
    temperature: float | None = None
    max_tokens: int | None = None


class LLMProvider:
    id: str = "llm"
    display_name: str = "LLM"

    async def chat(self, messages: list[dict], opts: LLMOptions | None = None) -> str:
        raise NotImplementedError

    async def stream_chat(
        self, messages: list[dict], opts: LLMOptions | None = None
    ) -> AsyncIterator[str]:
        yield ""


# ========== 图像 ==========


class ImageProvider:
    id: str = "image"
    display_name: str = "Image"

    async def generate(self, opts: dict) -> TaskHandle:
        """opts: prompt, size, refImages, count, negativePrompt, aspectRatio, category"""
        raise NotImplementedError


# ========== 视频 ==========


class VideoProvider:
    id: str = "video"
    display_name: str = "Video"

    async def submit(self, opts: dict) -> TaskHandle:
        """opts: imagePath, prompt, refImages, duration, aspectRatio, tailImagePath"""
        raise NotImplementedError

    async def get_task(self, provider_task_id: str) -> TaskHandle:
        raise NotImplementedError


# ========== TTS ==========


@dataclass
class TTSVoice:
    id: str
    name: str
    gender: str | None = None
    preview_url: str | None = None


class TTSProvider:
    id: str = "tts"
    display_name: str = "TTS"

    async def synthesize(self, opts: dict) -> TaskHandle:
        """opts: text, voiceId, emotion, rate, sampleRate, format"""
        raise NotImplementedError

    async def list_voices(self) -> list[TTSVoice]:
        return []
