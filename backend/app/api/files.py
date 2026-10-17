"""文件流式路由 — /file

GET /file?path=characters/xxx.png — 读取本地存储文件
- 仅允许 storage 目录内的相对路径（穿越防护）
- 支持 HTTP Range（视频拖动 / 断点续传必需）
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, Request, Response

from app.storage import STORAGE_ROOT

router = APIRouter()

MIME_OVERRIDES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".json": "application/json",
    ".srt": "text/plain",
    ".vtt": "text/vtt",
    ".txt": "text/plain",
}

_ROOT_RESOLVED = STORAGE_ROOT.resolve()


def _resolve(raw: str) -> tuple[str | None, str | None]:
    """返回 (rel_str, error)。rel_str 为 None 时 error 说明原因。"""
    if not raw:
        return None, "缺少 path"
    raw = unquote(raw)
    rel = raw.lstrip("/")
    p = (_ROOT_RESOLVED / rel).resolve()
    try:
        p.relative_to(_ROOT_RESOLVED)
    except ValueError:
        return None, "非法路径"
    if not p.exists() or not p.is_file():
        return None, "文件不存在"
    rel_str = str(p.relative_to(_ROOT_RESOLVED))
    return rel_str, None


def _mime_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in MIME_OVERRIDES:
        return MIME_OVERRIDES[ext]
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


@router.get("")
async def get_file(req: Request):
    raw = req.query_params.get("path") or ""
    rel, err = _resolve(raw)

    if rel is None:
        status = 400 if "非法" in (err or "") or "缺少" in (err or "") else 404
        return Response(status_code=status, content=err or "", media_type="text/plain")

    abs_p: Path = _ROOT_RESOLVED / rel
    size = abs_p.stat().st_size
    mime = _mime_for(abs_p)
    base_headers = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
    }

    range_header = req.headers.get("range")
    if range_header:
        m = _RANGE_RE.match(range_header.strip())
        start = 0
        end = size - 1
        if m:
            s, e = m.group(1), m.group(2)
            if s:
                start = int(s)
                if e:
                    end = min(int(e), size - 1)
            elif e:
                n = int(e)
                start = max(0, size - n)
            else:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{size}"},
                )
        if not (start <= end) or start >= size:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}"},
            )
        end = min(end, size - 1)
        with abs_p.open("rb") as f:
            f.seek(start)
            chunk = f.read(end - start + 1)
        return Response(
            content=chunk,
            status_code=206,
            media_type=mime,
            headers={
                **base_headers,
                "Content-Length": str(end - start + 1),
                "Content-Range": f"bytes {start}-{end}/{size}",
            },
        )

    with abs_p.open("rb") as f:
        data = f.read()
    return Response(
        content=data,
        media_type=mime,
        headers={**base_headers, "Content-Length": str(size)},
    )
