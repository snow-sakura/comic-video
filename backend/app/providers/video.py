"""视频供应商实现：Agnes AI Video 2.5（异步任务） + Mock

Agnes Video 2.5 API（OpenAI 兼容风格，非 /v1 路径）：
- 提交：POST https://apihub.agnes-ai.com/v1/videos
  body: { model, prompt, mode(text|keyframe|reference), seconds("4"-"12"),
          size("720P"|"1080P"|"1K"|"2K"), aspect_ratio, seed, n,
          first_frame/last_frame(keyframe), images/audios/reference(ref) }
- 轮询：GET https://apihub.agnes-ai.com/agnesapi?video_id=<id>&model_name=<model>
  响应 status: queued|processing|completed|failed，完成后 url 字段为视频地址
- 限流：免费用户 1 次/分钟（进程级串行闸门）
"""

from __future__ import annotations

import time

import httpx

from app.providers.base import TaskHandle, VideoProvider
from app.providers.settings import get_video_config, mask_key
from app.storage import download_to_storage, to_data_uri, file_exists, abs_path

AGNES_PROVIDER_ID = "agnes"
AGNES_RATE_LIMIT_MS = 60_000
_agn_last_submit_at = 0.0

# 提交重试：免费档限流 1 次/分钟 + 队列满 503 高发
_SUBMIT_MAX_RETRIES = 4
_SUBMIT_BACKOFF_SEC = [20, 40, 60, 60]
_SUBMIT_429_WAIT_SEC = 62  # 撞限流窗口就整分钟等一次


async def _agn_wait_rate_limit() -> None:
    global _agn_last_submit_at
    wait = AGNES_RATE_LIMIT_MS - (time.time() * 1000 - _agn_last_submit_at)
    if wait > 0:
        print(f"[video:agnes] 限流等待 {wait / 1000:.0f}s（每分钟 1 个任务）")
        await _sleep(wait / 1000)


def _sleep(seconds: float):
    import asyncio

    return asyncio.sleep(seconds)


class AgnesVideoProvider(VideoProvider):
    id = AGNES_PROVIDER_ID
    display_name = "Agnes Video 2.5 Flash"

    async def submit(self, opts: dict) -> TaskHandle:
        cfg = get_video_config()
        if not cfg["apiKey"]:
            raise PermissionError(
                "未配置 Agnes API Key（video.apiKey / VIDEO_API_KEY）"
            )

        await _agn_wait_rate_limit()
        global _agn_last_submit_at
        _agn_last_submit_at = time.time() * 1000

        # 分镜图 → Data URI（Agnes 支持 URL 或 data:base64）
        image = None
        if opts.get("imagePath") and file_exists(opts["imagePath"]):
            mime = (
                "image/jpeg"
                if opts["imagePath"].lower().endswith((".jpg", ".jpeg"))
                else "image/png"
            )
            image = to_data_uri(opts["imagePath"], mime)

        # 参考主体图（角色一致性，最多 5 张）
        ref_images: list[str] = []
        for ref in (opts.get("refImages") or [])[:5]:
            if ref.startswith("http"):
                ref_images.append(ref)
            elif file_exists(ref):
                ref_images.append(to_data_uri(ref))
        ref_images = [x for x in ref_images if x != image or x not in ref_images]

        # 模式选择：有分镜图 → keyframe（首帧控制）；有参考图 → reference；否则 text
        if image and not ref_images:
            mode = "keyframe"
        elif ref_images:
            mode = "reference"
        else:
            mode = "text"

        body: dict = {
            "model": cfg["model"],
            "prompt": (opts.get("prompt") or "")[:512],
            "mode": mode,
            "seconds": str(min(12, max(4, int(opts.get("duration", 5))))),
            "size": "720P",
            "aspect_ratio": opts.get("aspectRatio") or "16:9",
            "n": 1,
        }
        if mode == "keyframe":
            body["first_frame"] = image
            if opts.get("tailImagePath") and file_exists(opts["tailImagePath"]):
                body["last_frame"] = to_data_uri(opts["tailImagePath"])
        elif mode == "reference":
            body["images"] = ref_images or ([image] if image else [])

        url = f"{cfg['baseUrl']}/videos"

        # 重试：免费档 1 次/分钟、队列满 503 是常态，必须退避重试而非直接判失败
        last_err: Exception | None = None
        for attempt in range(_SUBMIT_MAX_RETRIES):
            if attempt > 0:
                wait = _SUBMIT_BACKOFF_SEC[min(attempt, len(_SUBMIT_BACKOFF_SEC) - 1)]
                print(
                    f"[video:agnes] 第{attempt}次重试，等待 {wait:.0f}s（{last_err}）"
                )
                await _sleep(wait)
            try:
                start = time.time()
                async with httpx.AsyncClient(timeout=60) as client:
                    res = await client.post(
                        url,
                        headers={
                            "Authorization": f"Bearer {cfg['apiKey']}",
                            "Content-Type": "application/json",
                        },
                        json=body,
                    )
            except httpx.HTTPError as e:
                last_err = RuntimeError(f"网络错误: {e}")
                continue

            print(
                f"[video:agnes] 提交 model={cfg['model']} key={mask_key(cfg['apiKey'])} mode={mode} status={res.status_code} 耗时={time.time() - start:.1f}s"
            )

            if res.status_code == 429:
                # 限流：等待窗口更久再试
                last_err = RuntimeError("Agnes 视频限流：每分钟最多提交 1 个任务")
                await _sleep(_SUBMIT_429_WAIT_SEC)
                continue
            if res.status_code == 503 or "queue_full" in res.text.lower():
                last_err = RuntimeError(f"Agnes 视频队列已满(503): {res.text[:200]}")
                continue
            if res.status_code != 200:
                # 其它 4xx 不重试（参数/key 问题，重试无意义）
                raise RuntimeError(
                    f"Agnes 提交失败 {res.status_code}: {res.text[:300]}"
                )
            data = res.json()
            task_id = data.get("video_id") or data.get("task_id") or data.get("id")
            if not task_id:
                raise RuntimeError(f"Agnes 未返回任务 id: {str(data)[:200]}")
            return TaskHandle(
                task_id=f"agnes-{int(time.time() * 1000)}",
                provider_task_id=task_id,
                status="queued",
            )
        raise last_err or RuntimeError("Agnes 视频提交失败")

    async def get_task(self, provider_task_id: str) -> TaskHandle:
        cfg = get_video_config()
        url = f"{cfg['baseUrl'].rsplit('/v1', 1)[0]}/agnesapi"
        params = {"video_id": provider_task_id, "model_name": cfg["model"]}
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.get(
                url, headers={"Authorization": f"Bearer {cfg['apiKey']}"}, params=params
            )
        data = res.json() if res.status_code == 200 else {}
        status = str(data.get("status", "")).lower()
        print(
            f"[video:agnes] 轮询 id={provider_task_id} status={status} progress={data.get('progress')}"
        )
        if status in ("completed", "success", "done") or (
            data.get("url") and status not in ("failed", "error")
        ):
            vurl = data.get("url")
            if not vurl:
                return TaskHandle(
                    task_id=provider_task_id,
                    provider_task_id=provider_task_id,
                    status="failed",
                    error="无视频结果",
                )
            video_path = await download_to_storage(vurl, "videos", ".mp4")
            return TaskHandle(
                task_id=provider_task_id,
                provider_task_id=provider_task_id,
                status="done",
                result={"videoPath": video_path},
            )
        if status in ("failed", "error", "reject", "cancel"):
            err = data.get("error")
            err_msg = err.get("message") if isinstance(err, dict) else str(err)
            return TaskHandle(
                task_id=provider_task_id,
                provider_task_id=provider_task_id,
                status="failed",
                error=err_msg or "Agnes 生成失败",
            )
        return TaskHandle(
            task_id=provider_task_id,
            provider_task_id=provider_task_id,
            status="processing",
        )


def create_agnes_video() -> VideoProvider:
    return AgnesVideoProvider()


# ========== Mock ==========

import subprocess


class MockVideoProvider(VideoProvider):
    id = "mock-video"
    display_name = "Mock 视频（无Key演示）"

    async def submit(self, opts: dict) -> TaskHandle:
        duration = int(opts.get("duration", 5))
        from app.storage import unique_name

        _, path, rel = unique_name("videos", ".mp4")
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    f"color=c=0x2a2a4a:s=1280x720:d={duration}",
                    "-f",
                    "lavfi",
                    "-i",
                    f"sine=frequency=440:duration={duration}",
                    "-shortest",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-c:a",
                    "aac",
                    str(path),
                ],
                capture_output=True,
                timeout=30,
            )
            return TaskHandle(
                task_id=f"mock-video-{int(time.time() * 1000)}",
                provider_task_id="mock",
                status="done",
                result={"videoPath": rel},
            )
        except Exception:
            path.write_bytes(b"mock-video")
            return TaskHandle(
                task_id=f"mock-video-{int(time.time() * 1000)}",
                provider_task_id="mock",
                status="done",
                result={"videoPath": rel},
            )

    async def get_task(self, provider_task_id: str) -> TaskHandle:
        return TaskHandle(task_id="", status="processing")


def create_mock_video() -> VideoProvider:
    return MockVideoProvider()


def create_video_provider(provider_id: str | None = None):
    provider_id = provider_id or get_video_config().get("provider", "agnes")
    if provider_id == AGNES_PROVIDER_ID:
        return create_agnes_video()
    return create_mock_video()
