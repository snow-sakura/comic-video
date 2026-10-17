"""图像供应商实现：Agnes AI 全家桶 + Mock

Agnes Image（OpenAI 兼容 /images/generations）：
- 支持文生图 / 图生图 / 多图合成
- size 档位 1K/2K/3K/4K + ratio 比例
- 参考图放 extra_body.image（URL 或 Data URI Base64），前 3 张免费
- 输出 extra_body.response_format = url / b64_json
"""

from __future__ import annotations

import asyncio
import time

import httpx

from app.providers.base import ImageProvider, TaskHandle
from app.providers.settings import get_image_config, mask_key
from app.storage import download_to_storage, to_data_uri, file_exists, save_file

AGNES_PROVIDER_ID = "agnes"

# Agnes 图像限流：429 / 5xx 自动退避重试参数
_IMAGE_MAX_RETRIES = 4
_IMAGE_BACKOFF_BASE_SEC = 15
_IMAGE_BACKOFF_MAX_SEC = 120


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def agnes_size(aspect: str | None = None) -> tuple[str, str]:
    """出图比例 → (size 档位, ratio)。16:9 横屏分镜 → 2K + 16:9"""
    if aspect in ("16:9", None):
        return "2K", aspect or "16:9"
    if aspect == "9:16":
        return "2K", "9:16"
    if aspect == "3:4":
        return "2K", "3:4"
    if aspect == "4:3":
        return "2K", "4:3"
    return "1K", "1:1"


def _is_rate_limited(status: int) -> bool:
    return status == 429 or status >= 500


async def _agnes_generate_once(
    url: str, headers: dict, body: dict, round_no: int, count: int
) -> dict:
    """单次出图调用（429/5xx 指数退避重试），返回响应 JSON"""
    start = time.time()
    for attempt in range(_IMAGE_MAX_RETRIES):
        async with httpx.AsyncClient(timeout=180) as client:
            res = await client.post(url, headers=headers, json=body)
        if _is_rate_limited(res.status_code):
            retry_after = res.headers.get("Retry-After")
            if retry_after:
                try:
                    wait = float(retry_after)
                except ValueError:
                    wait = min(
                        _IMAGE_BACKOFF_MAX_SEC, _IMAGE_BACKOFF_BASE_SEC * (2**attempt)
                    )
            else:
                wait = min(
                    _IMAGE_BACKOFF_MAX_SEC, _IMAGE_BACKOFF_BASE_SEC * (2**attempt)
                )
            print(
                f"[image:agnes] 限流 status={res.status_code} round={round_no}/{count} "
                f"第{attempt + 1}次，{wait:.0f}s 后重试…"
            )
            await _sleep(wait)
            continue
        print(
            f"[image:agnes] 响应 status={res.status_code} round={round_no}/{count} "
            f"耗时={time.time() - start:.1f}s"
        )
        if res.status_code != 200:
            text = res.text[:300]
            raise RuntimeError(f"Agnes 图像生成失败 {res.status_code}: {text}")
        data = res.json()
        if data.get("error"):
            raise RuntimeError(f"Agnes 图像生成失败: {data['error'].get('message')}")
        return data
    raise RuntimeError(f"Agnes 图像生成限流重试耗尽 round={round_no}/{count}")


class AgnesImageProvider(ImageProvider):
    id = AGNES_PROVIDER_ID
    display_name = "Agnes Image 2.5 Flash"

    async def generate(self, opts: dict) -> TaskHandle:
        cfg = get_image_config()
        count = max(1, int(opts.get("count", 1)))
        size, ratio = agnes_size(opts.get("aspectRatio"))
        ref_images: list[str] = []
        for ref in opts.get("refImages") or []:
            if ref.startswith("http"):
                ref_images.append(ref)
            elif file_exists(ref):
                mime = (
                    "image/jpeg"
                    if ref.lower().endswith((".jpg", ".jpeg"))
                    else "image/png"
                )
                ref_images.append(to_data_uri(ref, mime))

        image_paths: list[str] = []
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['apiKey']}",
        }
        url = f"{cfg['baseUrl']}/images/generations"

        # Agnes 单次出 1 张，count>1 时串行多次调用
        for i in range(count):
            body: dict = {
                "model": cfg["model"],
                "prompt": opts.get("prompt", ""),
                "size": size,
                "ratio": ratio,
                "extra_body": {"response_format": "url"},
            }
            if ref_images:
                body["extra_body"]["image"] = ref_images
            if opts.get("negativePrompt"):
                body["extra_body"]["negative_prompt"] = opts["negativePrompt"]

            data = await _agnes_generate_once(url, headers, body, i + 1, count)
            item = (data.get("data") or [{}])[0]
            cat = opts.get("category") or ("characters" if count > 1 else "shots")
            if item.get("url"):
                image_paths.append(await download_to_storage(item["url"], cat, ".png"))
            elif item.get("b64_json"):
                import base64

                image_paths.append(
                    save_file(cat, base64.b64decode(item["b64_json"]), ".png")
                )

        return TaskHandle(
            task_id=f"agnes-img-{int(time.time() * 1000)}",
            status="done",
            result={"imagePaths": image_paths},
        )


def create_agnes_image() -> ImageProvider:
    return AgnesImageProvider()


# ========== Mock ==========

import base64
import struct
import zlib


def _placeholder_png(
    w: int = 256, h: int = 256, color: tuple[int, int, int] = (142, 95, 158)
) -> bytes:
    """手写最小 PNG（无 canvas 依赖）"""

    def chunk(ctype: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + ctype + data
        return c + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(color) * w for _ in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class MockImageProvider(ImageProvider):
    id = "mock-image"
    display_name = "Mock 图像（无Key演示）"

    async def generate(self, opts: dict) -> TaskHandle:
        count = int(opts.get("count", 1))
        paths = [save_file("shots", _placeholder_png(), ".png") for _ in range(count)]
        return TaskHandle(
            task_id=f"mock-img-{int(time.time() * 1000)}",
            status="done",
            result={"imagePaths": paths},
        )


def create_mock_image() -> ImageProvider:
    return MockImageProvider()


def create_image_provider(provider_id: str | None = None):
    provider_id = provider_id or get_image_config().get("provider", "agnes")
    if provider_id == AGNES_PROVIDER_ID:
        return create_agnes_image()
    return create_mock_image()
