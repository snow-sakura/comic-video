"""整集 ZIP 导出

build_episode_export：收集该集全部镜头素材 + 成片 + 字幕 + 剧本 + 清单 → ZIP
输出到 storage/exports/，已存在则复用缓存。
"""

from __future__ import annotations

import json
import os
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import get_settings
from app.storage import STORAGE_ROOT, abs_path, file_exists, read_file


def _ext(p: str) -> str:
    return os.path.splitext(p)[1]


def _build_zip(entries: list[tuple[str, bytes]]) -> bytes:
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            zf.writestr(name, data)
    return buf.getvalue()


def _safe_title(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", title)[:40] or "project"


async def build_episode_export(
    db,
    project_id: str,
    episode_number: int,
) -> str:
    """返回 ZIP 相对路径（如 exports/xxx.zip），已存在则复用"""
    from app.models import Project, Episode, Shot, Script
    from sqlalchemy import select

    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not project:
        raise ValueError("项目不存在")
    episode = (
        await db.execute(
            select(Episode).where(
                Episode.project_id == project_id, Episode.number == episode_number
            )
        )
    ).scalar_one_or_none()
    if not episode:
        raise ValueError("剧集不存在")
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
    script = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == project_id)
                .order_by(Script.version.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )

    root_name = f"{_safe_title(project.title)}-ep{episode.number}-export"
    zip_name = f"{root_name}.zip"
    zip_rel = f"exports/{zip_name}"

    # 缓存复用：非空 zip 已存在则直接返回
    if file_exists(zip_rel) and abs_path(zip_rel).stat().st_size > 0:
        return zip_rel

    entries: list[tuple[str, bytes]] = []

    manifest = {
        "projectId": project_id,
        "title": project.title,
        "episode": episode.number,
        "episodeTitle": episode.title or "",
        "shotCount": len(shots),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "shots": [
            {
                "sequence": s.sequence,
                "sceneName": s.scene_name,
                "status": s.status,
                "duration": s.duration,
                "dialog": s.dialog,
                "image": s.image_path,
                "video": s.video_path,
                "voice": s.voice_path,
            }
            for s in shots
        ],
    }
    entries.append(
        (
            f"{root_name}/manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        )
    )

    # 成片 + 字幕
    if episode.final_path and file_exists(episode.final_path):
        base = os.path.splitext(os.path.basename(episode.final_path))[0]
        ext = _ext(episode.final_path)
        entries.append(
            (f"{root_name}/final/{base}{ext}", read_file(episode.final_path))
        )
        for sub in (".srt", ".vtt"):
            sub_rel = re.sub(r"\.mp4$", sub, episode.final_path)
            if file_exists(sub_rel):
                entries.append((f"{root_name}/final/{base}{sub}", read_file(sub_rel)))

    # 各镜头素材
    for s in shots:
        dir_name = (
            f"{root_name}/shots/{str(s.sequence).zfill(2)}-{s.scene_name or 'shot'}"
        )
        if s.image_path and file_exists(s.image_path):
            entries.append(
                (f"{dir_name}/image{_ext(s.image_path)}", read_file(s.image_path))
            )
        if s.video_path and file_exists(s.video_path):
            entries.append(
                (f"{dir_name}/video{_ext(s.video_path)}", read_file(s.video_path))
            )
        if s.voice_path and file_exists(s.voice_path):
            entries.append(
                (f"{dir_name}/voice{_ext(s.voice_path)}", read_file(s.voice_path))
            )
        entries.append(
            (
                f"{dir_name}/dialog.json",
                json.dumps(
                    {
                        "sequence": s.sequence,
                        "sceneName": s.scene_name,
                        "action": s.action,
                        "dialog": s.dialog,
                        "dialogChar": s.dialog_char,
                        "duration": s.duration,
                        "status": s.status,
                        "camera": s.camera,
                        "finalPrompt": s.final_prompt,
                    },
                    ensure_ascii=False,
                    indent=2,
                ).encode("utf-8"),
            )
        )

    # 剧本
    if script and script.content:
        content = (
            script.content
            if isinstance(script.content, str)
            else json.dumps(script.content, ensure_ascii=False, indent=2)
        )
        entries.append((f"{root_name}/script.json", content.encode("utf-8")))

    zip_buf = _build_zip(entries)
    export_dir = get_settings().storage_root / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    zip_path = export_dir / zip_name
    zip_path.write_bytes(zip_buf)
    if not zip_path.exists():
        raise ValueError("导出失败：ZIP 未生成")
    return zip_rel
