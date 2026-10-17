"""视频质量检查

qc_video：校验成片文件可被 ffprobe 解析（时长/流/容器），返回 { ok, warnings, errors }。
WARN 记录日志；FAIL 抛错触发队列重试。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from app.storage import abs_path, file_exists


def qc_video(rel_path: str) -> dict[str, Any]:
    """
    rel_path: storage 内相对路径（如 videos/xxx.mp4）
    返回 { ok: bool, warnings: [str], errors: [str], duration?: float }

    注意：用同步 subprocess 而非 asyncio.run，
    因为本函数可能在 Celery worker 的 asyncio.run 事件循环内被调用，
    嵌套 asyncio.run 会抛 "cannot be called from a running event loop"。
    """
    warnings: list[str] = []
    errors: list[str] = []

    if not rel_path:
        return {"ok": False, "warnings": warnings, "errors": ["缺少视频路径"]}
    if not file_exists(rel_path):
        return {
            "ok": False,
            "warnings": warnings,
            "errors": [f"视频文件不存在: {rel_path}"],
        }

    p: Path = abs_path(rel_path)
    if p.stat().st_size == 0:
        errors.append(f"视频文件为空: {rel_path}")
        return {"ok": False, "warnings": warnings, "errors": errors}

    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(p),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        data = json.loads(proc.stdout) if proc.stdout else {}
    except Exception as e:
        errors.append(f"ffprobe 解析失败: {e}")
        return {"ok": False, "warnings": warnings, "errors": errors}

    duration = float(data.get("format", {}).get("duration", 0) or 0)
    if duration <= 0:
        errors.append("视频时长为 0 或无法解析")
    else:
        if duration < 1:
            warnings.append(f"视频时长过短（{duration:.1f}s）")
        elif duration > 300:
            warnings.append(f"视频时长过长（{duration:.0f}s）")

    vstreams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    if not vstreams:
        errors.append("缺少视频流")
    return {
        "ok": len(errors) == 0,
        "warnings": warnings,
        "errors": errors,
        "duration": duration,
    }
