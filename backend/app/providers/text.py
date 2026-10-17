"""文本（LLM）供应商实现：Agnes AI 全家桶（默认） + 通用 OpenAI 兼容 + Mock

文本模型（OpenAI 兼容 chat/completions）：
- 默认 Agnes（agnes-3.0-flash / agnes-image / agnes-video / agnes-tts）
- openai 兼容端点（OpenCode Zen 等，TEXT_PROVIDER=openai）
- 全部走 OpenAI 兼容协议；限流 429 / 5xx 自动指数退避重试。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import AsyncIterator

import httpx

from app.providers.base import LLMOptions, LLMProvider
from app.providers.settings import get_text_config, get_setting_sync, mask_key

AGNES_PROVIDER_ID = "agnes"
OPENAI_PROVIDER_ID = "openai"

_AGNES_BASE = "https://apihub.agnes-ai.com/v1"

# LLM 单次调用读超时：实测长剧本单次生成可达 408s，
# 300s 会在长文本场景触发无谓的网络错误重试（见 2026-10-16 E2E 验证 P2），
# 故上调默认 600s，并允许 TEXT_TIMEOUT_SEC 覆盖。
_LLM_TIMEOUT_SEC = float(os.environ.get("TEXT_TIMEOUT_SEC", "600") or 600)

# 可选文本模型清单（设置页下拉展示，最新排前）
AGNES_TEXT_MODELS: list[dict] = [
    {
        "id": "agnes-3.0-flash",
        "name": "Agnes 3.0 Flash（免费·默认）",
        "ctx": "512K",
        "note": "Agent 任务 / 工具调用 / 长上下文",
    },
    {
        "id": "agnes-3.0-flash-max",
        "name": "Agnes 3.0 Flash Max（付费）",
        "ctx": "512K",
        "note": "推理型，128K 输出预算",
    },
    {
        "id": "agnes-2.5-flash",
        "name": "Agnes 2.5 Flash（免费）",
        "ctx": "512K",
        "note": "轻量备选",
    },
    {
        "id": "agnes-2.5-pro",
        "name": "Agnes 2.5 Pro（付费）",
        "ctx": "长上下文",
        "note": "高级推理 / 科学推理",
    },
    {
        "id": "agnes-1.5-flash",
        "name": "Agnes 1.5 Flash（轻量）",
        "ctx": "256K",
        "note": "低延迟任务",
    },
    {
        "id": "agnes-3.0-pro",
        "name": "Agnes 3.0 Pro（即将上线）",
        "ctx": "长上下文",
        "note": "专业文档分析（预留）",
    },
]

# OpenAI 兼容（OpenCode Zen）模型清单
OPENAI_TEXT_MODELS: list[dict] = [
    {
        "id": "deepseek-v4-flash-free",
        "name": "DeepSeek v4 Flash（免费）",
        "ctx": "长上下文",
        "note": "OpenCode Zen 免费档",
    },
]

# 限流重试参数
_MAX_RETRIES = 5
_BACKOFF_BASE_SEC = 8
_BACKOFF_MAX_SEC = 120


def _split_system(messages: list[dict]) -> tuple[str | None, list[dict]]:
    parts: list[str] = []
    rest: list[dict] = []
    for m in messages:
        if m.get("role") == "system":
            parts.append(m.get("content", ""))
        else:
            rest.append(m)
    return ("\n\n".join(parts) or None, rest)


class OpenAICompatProvider(LLMProvider):
    """OpenAI 兼容文本模型（Agnes / OpenCode Zen 等共用）"""

    display_name = "文本模型"

    def __init__(self) -> None:
        self.id = get_setting_sync("text.provider") or AGNES_PROVIDER_ID

    async def _call(self, messages: list[dict], opts: LLMOptions, stream: bool) -> dict:
        cfg = get_text_config()
        if not cfg.get("apiKey"):
            raise PermissionError("未配置 API Key（TEXT_API_KEY）")
        system, rest = _split_system(messages)
        body: dict = {
            "model": cfg["model"],
            "messages": ([{"role": "system", "content": system}] if system else [])
            + rest,
            "temperature": opts.temperature
            if opts and opts.temperature is not None
            else 0.7,
            "max_tokens": (opts.max_tokens or 8192) if opts else 8192,
            "stream": stream,
        }
        url = f"{cfg['baseUrl']}/chat/completions"
        start = time.time()
        if stream:
            raise NotImplementedError  # 当前业务只需结构化 JSON 输出，走同步

        last_error: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            try:
                async with httpx.AsyncClient(timeout=_LLM_TIMEOUT_SEC) as client:
                    res = await client.post(
                        url,
                        headers={
                            "Authorization": f"Bearer {cfg['apiKey']}",
                            "Content-Type": "application/json",
                        },
                        json=body,
                    )
                if res.status_code == 429 or res.status_code >= 500:
                    # 限流 / 服务端错误：指数退避重试
                    retry_after = res.headers.get("Retry-After")
                    if retry_after:
                        try:
                            wait = float(retry_after)
                        except ValueError:
                            wait = min(
                                _BACKOFF_MAX_SEC, _BACKOFF_BASE_SEC * (2**attempt)
                            )
                    else:
                        wait = min(_BACKOFF_MAX_SEC, _BACKOFF_BASE_SEC * (2**attempt))
                    print(
                        f"[llm] status={res.status_code} 第{attempt + 1}次失败，{wait:.0f}s 后重试…"
                    )
                    await asyncio.sleep(wait)
                    last_error = RuntimeError(
                        f"LLM 返回 {res.status_code}: {res.text[:300]}"
                    )
                    continue
                if res.status_code != 200:
                    raise RuntimeError(f"LLM 失败 {res.status_code}: {res.text[:300]}")
                print(
                    f"[llm] 调用 model={cfg['model']} msgs={len(messages)} "
                    f"耗时={time.time() - start:.1f}s status={res.status_code}"
                )
                return res.json()
            except httpx.HTTPError as e:
                # 网络错误：同样退避重试
                print(f"[llm] 网络错误第{attempt + 1}次: {e}，退避重试…")
                await asyncio.sleep(
                    min(_BACKOFF_MAX_SEC, _BACKOFF_BASE_SEC * (2**attempt))
                )
                last_error = e
                continue
        raise last_error or RuntimeError("LLM 调用失败")

    async def chat(self, messages: list[dict], opts: LLMOptions | None = None) -> str:
        opts = opts or LLMOptions()
        data = await self._call(messages, opts, stream=False)
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        # JSON 输出要求：剥掉可能的 ```json 代码块包裹
        if opts.json and text:
            t = text.strip()
            if t.startswith("```"):
                t = t.split("\n", 1)[-1]
                if t.endswith("```"):
                    t = t[:-3]
            text = t.strip()
        return text

    async def stream_chat(
        self, messages: list[dict], opts: LLMOptions | None = None
    ) -> AsyncIterator[str]:
        text = await self.chat(messages, opts)
        for i in range(0, len(text), 40):
            yield text[i : i + 40]


def create_openai_compat_text() -> LLMProvider:
    """OpenAI 兼容文本模型（Agnes / OpenCode Zen 通用）"""
    return OpenAICompatProvider()


def create_agnes_text() -> LLMProvider:
    """Agnes 文本模型（OpenAI 兼容）"""
    return OpenAICompatProvider()


class MockLLMProvider(LLMProvider):
    id = "mock-llm"
    display_name = "Mock LLM（无Key演示）"

    async def chat(self, messages: list[dict], opts: LLMOptions | None = None) -> str:
        last = messages[-1].get("content", "") if messages else ""
        if opts and opts.json:
            return json.dumps(
                {
                    "mock": True,
                    "note": "未配置 API Key，当前为 Mock 输出。请在设置页或 .env 配置 TEXT_API_KEY / TEXT_MODEL。",
                    "echo": last[:200],
                },
                ensure_ascii=False,
            )
        return f"【Mock 输出】未配置 API Key。请在设置页或 .env 配置 TEXT_API_KEY / TEXT_MODEL 后重新生成。\n\n（输入摘要：{last[:300]}）"

    async def stream_chat(
        self, messages: list[dict], opts: LLMOptions | None = None
    ) -> AsyncIterator[str]:
        out = await self.chat(messages, opts)
        for i in range(0, len(out), 20):
            yield out[i : i + 20]


def create_mock_llm() -> LLMProvider:
    return MockLLMProvider()


def create_llm_provider(provider_id: str | None = None) -> LLMProvider:
    provider_id = provider_id or get_setting_sync("text.provider") or AGNES_PROVIDER_ID
    if provider_id == "mock":
        return create_mock_llm()
    # agnes / openai / 其它 OpenAI 兼容端点 → 统一走兼容实现
    return create_openai_compat_text()
