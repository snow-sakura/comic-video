"""本地文件存储管理

storage/
  novels/ characters/ scenes/ props/ shots/ clips/ videos/ audio/
  subs/ bgm/ sfx/ exports/ temp/
"""
from __future__ import annotations

import base64
import secrets
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from app.core.config import get_settings

DIRS = {
    "novels": "novels",
    "characters": "characters",
    "scenes": "scenes",
    "props": "props",
    "shots": "shots",
    "clips": "clips",
    "videos": "videos",
    "audio": "audio",
    "subs": "subs",
    "bgm": "bgm",
    "sfx": "sfx",
    "exports": "exports",
    "temp": "temp",
}


def _root() -> Path:
    p = get_settings().storage_root
    p.mkdir(parents=True, exist_ok=True)
    return p


STORAGE_ROOT = _root()


def _ensure_dir(cat: str) -> Path:
    d = STORAGE_ROOT / DIRS[cat]
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_storage() -> None:
    for cat in DIRS.values():
        _ensure_dir(cat)


def _nano_id(n: int = 8) -> str:
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    return "".join(secrets.choice(alphabet) for _ in range(n))


def unique_name(cat: str, ext: str = ".png") -> tuple[Path, Path, str]:
    """返回 (绝对目录, 绝对路径, 相对路径)"""
    d = _ensure_dir(cat)
    if not ext.startswith("."):
        ext = "." + ext
    name = f"{int(time.time() * 1000)}-{_nano_id()}{ext}"
    return d, d / name, f"{DIRS[cat]}/{name}"


def save_file(cat: str, data: bytes | str, ext: str | None = None) -> str:
    _, path, rel = unique_name(cat, ext or ".png")
    if isinstance(data, str):
        data = data.encode("utf-8")
    path.write_bytes(data)
    return rel


def abs_path(rel_path: str) -> Path:
    return STORAGE_ROOT / rel_path


def file_exists(rel_path: str) -> bool:
    return abs_path(rel_path).exists()


def read_file(rel_path: str) -> bytes:
    return abs_path(rel_path).read_bytes()


def to_data_uri(rel_path: str, mime: str = "image/png") -> str:
    b64 = base64.b64encode(read_file(rel_path)).decode()
    return f"data:{mime};base64,{b64}"


def remove_file(rel_path: str) -> bool:
    p = abs_path(rel_path)
    try:
        if p.exists():
            p.unlink()
            return True
    except OSError:
        return False
    return False


async def download_to_storage(url: str, cat: str, ext: str | None = None) -> str:
    """下载 URL 到存储，返回相对路径"""
    start = time.time()
    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.get(url)
        if res.status_code != 200:
            raise RuntimeError(f"下载失败 {url}: {res.status_code}")
        buf = res.content
    guess = ext
    if not guess:
        guess = Path(urlparse(url).path).suffix or ".png"
    rel = save_file(cat, buf, guess)
    print(f"[storage] 下载完成 url={url[:60]} cat={cat} 耗时={time.time() - start:.1f}s")
    return rel
