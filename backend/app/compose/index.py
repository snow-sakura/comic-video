"""视频合成（ffmpeg）

compose_episode：把一集全部 VIDEO_DONE 镜头按顺序拼接为单个 mp4，
可选叠加 BGM（storage/bgm/*.mp3），导出到 storage/exports/。
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import Episode, Shot
from app.storage import abs_path


def _find_bgm(mood: str | None) -> str | None:
    """按情绪关键词查找 BGM 文件（storage/bgm/<mood>.mp3 或任意匹配）"""
    if not mood:
        return None
    settings = get_settings()
    bgm_dir = settings.storage_root / "bgm"
    if not bgm_dir.exists():
        return None
    # 精确：mood.mp3 / mood.wav
    for suffix in (".mp3", ".wav", ".m4a"):
        p = bgm_dir / f"{mood}{suffix}"
        if p.exists():
            return str(p)
    # 模糊：文件名包含 mood 关键词
    for f in bgm_dir.iterdir():
        if mood in f.name and f.suffix in (".mp3", ".wav", ".m4a"):
            return str(f)
    return None


async def compose_episode(
    db: AsyncSession,
    episode: Episode,
    bgm_mood: str | None = None,
) -> dict[str, Any]:
    """合成单集：收集该集全部有 videoPath 的镜头 → ffmpeg 拼接 → 写回 Episode.finalPath"""
    settings = get_settings()
    export_dir = settings.storage_root / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)

    shots = (
        (
            await db.execute(
                select(Shot)
                .where(Shot.episode_id == episode.id)
                .order_by(Shot.sequence)
            )
        )
        .scalars()
        .all()
    )

    video_paths = [s.video_path for s in shots if s.video_path]
    if not video_paths:
        raise ValueError("该集没有任何可用视频片段")
    # 完整性校验：部分镜头缺视频时禁止合成，否则会产出"缺一大截"的残片成片
    missing = [s for s in shots if not s.video_path]
    if missing:
        seqs = "、".join(str(s.sequence) for s in missing)
        raise ValueError(
            f"该集还有 {len(missing)}/{len(shots)} 个镜头未生成视频（镜头号 {seqs}），"
            "请先在视频合成厂为这些镜头生成视频，再合成整集"
        )

    # 音频路径（配音）
    audio_paths = [s.voice_path for s in shots if s.voice_path]
    audio_list_name: str | None = None
    tmp_files: list[str] = []

    # 存的是相对路径（如 videos/xxx.mp4），concat demuxer 的 file 列表需要绝对路径
    video_abs = [str(abs_path(vp)) for vp in video_paths]
    audio_abs = [str(abs_path(ap)) for ap in audio_paths]

    ts_list_file = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
    for vp in video_abs:
        ts_list_file.write(f"file '{vp}'\n")
    ts_list_file.flush()
    ts_list_file.close()
    tmp_files.append(ts_list_file.name)

    if audio_abs:
        audio_list = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        for ap in audio_abs:
            audio_list.write(f"file '{ap}'\n")
        audio_list.flush()
        audio_list.close()
        audio_list_name = audio_list.name
        tmp_files.append(audio_list_name)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = str(export_dir / f"ep{episode.number}_{stamp}.mp4")

    if audio_list_name:
        # 视频拼接 + 配音混音（-shortest 保护）
        # 音频输入也要 -f concat，否则 ffmpeg 会把 list.txt 当普通媒体文件解析报 Invalid data
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            ts_list_file.name,
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            audio_list_name,
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
        ]
    else:
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            ts_list_file.name,
            "-c",
            "copy",
        ]

    # BGM：追加 -i bgm 并对齐音轨
    bgm_path = _find_bgm(bgm_mood)
    if bgm_path:
        if audio_list_name:
            # 已有配音，BGM 作为第三轨混音（简化：直接拼接，生产环境可用 amix）
            cmd += ["-i", bgm_path, "-map", "0:v", "-map", "1:a"]
        else:
            cmd += ["-i", bgm_path, "-map", "0:v", "-map", "1:a", "-shortest"]
    cmd += ["-movflags", "+faststart", out_path]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg 合成失败 rc={proc.returncode}: {stderr.decode()[-2000:]}"
        )

    # 写回
    episode.final_path = out_path
    episode.status = "DONE"
    for s in shots:
        if s.video_path:
            s.status = "COMPOSED"
    await db.flush()

    # 清理临时文件
    for f in tmp_files:
        if f and os.path.exists(f):
            try:
                os.unlink(f)
            except OSError:
                pass

    return {
        "episodeId": episode.id,
        "finalPath": out_path,
        "videoCount": len(video_paths),
        "bgmUsed": bgm_mood,
    }
