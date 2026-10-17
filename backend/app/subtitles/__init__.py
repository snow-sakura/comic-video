"""字幕估算与音频探测

estimate_subtitles：按标点切句 + 时长比例分配，生成 {start,end,text}（毫秒）。
probe_audio_duration：ffprobe 探测音频时长（秒）。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from app.core.config import get_settings

# 分句标点（中文为主）
_CUE_SPLIT_RE = re.compile(r"([。！？，、；…]+)")


def _cjk_char_count(s: str) -> int:
    return (
        len(re.findall(r"[\u4e00-\u9fff]", s))
        + len(re.sub(r"[\u4e00-\u9fff]", "", s)) // 2
    )


def split_cues(text: str, max_len: int = 18) -> list[str]:
    """按标点切句，长句再按 max_len 折行（每行 ≤max_len 字符）"""
    parts = _CUE_SPLIT_RE.split(text)
    sentences: list[str] = []
    buf = ""
    for p in parts:
        if _CUE_SPLIT_RE.fullmatch(p):
            buf += p
            sentences.append(buf.strip())
            buf = ""
        else:
            buf += p
    if buf.strip():
        sentences.append(buf.strip())

    cues: list[str] = []
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        # 长句按标点再拆
        if len(s) > max_len * 2:
            for chunk in _CUE_SPLIT_RE.split(s):
                chunk = chunk.strip()
                if chunk:
                    cues.append(chunk)
        else:
            cues.append(s)
    return cues


def estimate_subtitles(text: str, total_sec: float) -> list[dict]:
    """按句子长度比例分配总时长，返回 [{start, end, text}]（毫秒）"""
    cues = split_cues(text)
    if not cues or total_sec <= 0:
        return []
    total_ms = int(total_sec * 1000)
    # 按每句字符数（近似）比例分配
    weights = [max(1, _cjk_char_count(c)) for c in cues]
    total_w = sum(weights)
    start = 0
    out: list[dict] = []
    for i, c in enumerate(cues):
        dur = int(total_ms * weights[i] / total_w)
        end = start + dur
        out.append({"start": start, "end": end, "text": c})
        start = end
    # 保证末句结束等于总时长
    if out:
        out[-1]["end"] = total_ms
    return out


def _abs(rel_path: str) -> Path:
    return get_settings().storage_root / rel_path


def probe_audio_duration(rel_path: str) -> float:
    """用 ffprobe 探测音频时长（秒）。rel_path 为 storage 内相对路径。

    用同步 subprocess：本函数可能在 Celery worker 的 asyncio.run 事件循环内被调用，
    嵌套 asyncio.run 会抛 "cannot be called from a running event loop"。
    """
    p = _abs(rel_path)
    if not p.exists():
        raise ValueError(f"无法探测音频时长: 文件不存在 {rel_path}")

    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(p),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        val = proc.stdout.strip()
        dur = float(val)
    except Exception as e:
        raise ValueError(f"无法解析音频时长: {rel_path} ({e})")
    if not dur or dur <= 0:
        raise ValueError(f"无法解析音频时长: {rel_path}")
    return dur
