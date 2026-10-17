"""分镜车间：7 维提示词组装"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Shot, Character, Scene, Project, Script
from app.prompts.registry import render_prompt
from app.assets.prompts import style_anchor
from app.json_utils import as_record, as_string


def _camera_defaults() -> dict:
    return {"angle": "平视", "movement": "固定", "shotSize": "中景"}


def build_shot_7dim(
    shot: dict,
    character_card: dict | None,
    style_anchor_str: str,
    aspect_ratio: str = "16:9",
) -> dict:
    """把镜头字段组装成 7 维出图提示词（对应 buildShot7Dim）"""
    camera = as_record(shot.get("camera")) or _camera_defaults()
    dialog = as_string(shot.get("dialog"))
    dialog_char = as_string(shot.get("dialogChar"))
    action = as_string(shot.get("action"))
    scene_name = as_string(shot.get("sceneName"))

    # 角色外观锚点
    char_desc = ""
    if character_card:
        appearance = as_record(character_card.get("appearance"))
        char_desc = (
            f"{as_string(character_card.get('name'))}：发型「{as_string(appearance.get('hair'), '待定')}」"
            f"服装「{as_string(appearance.get('costume'), '待定')}」"
        )

    # 分镜七维
    dims = {
        "场景": scene_name or "未定场景",
        "景别": camera.get("shotSize", "中景"),
        "视角": camera.get("angle", "平视"),
        "运镜": camera.get("movement", "固定"),
        "画面内容": action or "（画面描述缺失）",
        "角色外观": char_desc or "（无角色出场）",
        "台词": dialog or "（无台词）",
    }

    # 出图提示词（供 Agnes 图像模型）
    prompt_lines = [
        f"场景：{dims['场景']}",
        f"景别：{dims['景别']}，视角：{dims['视角']}，运镜：{dims['运镜']}",
        f"画面：{dims['画面内容']}",
        f"角色：{dims['角色外观']}",
        f"全局画风：{style_anchor_str}",
        f"画面比例 {aspect_ratio}，无文字水印",
    ]
    if dialog:
        prompt_lines.insert(4, f"台词参考（仅供口型提示，不出现在画面）：{dialog}")

    return {
        "dims": dims,
        "prompt7": json.dumps(dims, ensure_ascii=False),
        "final_prompt": "\n".join(prompt_lines),
    }


async def assemble_shot_prompts(
    db: AsyncSession,
    project_id: str,
    episode_id: str,
) -> int:
    """组装该集全部镜头的 7 维提示词 + 锁定参考图（幂等）"""
    # 取项目风格锚点
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    anchor = style_anchor(as_record(project.style) if project else None)

    # 角色 → 名字映射（ORM → dict，避免 build_shot_7dim 调 .get() 崩溃）
    chars = (
        (await db.execute(select(Character).where(Character.project_id == project_id)))
        .scalars()
        .all()
    )
    char_by_name = {
        c.name: {
            "name": c.name,
            "appearance": as_record(c.appearance),
            # ref_image_ids 本身就是 list（JSONB），不能过 as_record（list→{}）
            "ref_image_ids": list(c.ref_image_ids or []),
        }
        for c in chars
    }

    shots = (
        (
            await db.execute(
                select(Shot)
                .where(Shot.episode_id == episode_id)
                .order_by(Shot.sequence)
            )
        )
        .scalars()
        .all()
    )

    for shot in shots:
        shot_dict: dict[str, Any] = {
            "camera": as_record(shot.camera),
            "action": shot.action,
            "dialog": shot.dialog,
            "dialogChar": shot.dialog_char,
            "sceneName": shot.scene_name,
        }
        card = char_by_name.get(shot.dialog_char) if shot.dialog_char else None
        result = build_shot_7dim(shot_dict, card, anchor)
        shot.prompt7 = result["dims"]
        shot.final_prompt = result["final_prompt"]

        # 锁定参考图：角色定妆照 + 场景空镜（ref_image_ids 是 list，勿过 as_record）
        ref_images: list[str] = []
        if card:
            ref_images.extend(list(card.get("ref_image_ids") or []))
        # 场景空镜
        scene_rows = (
            (await db.execute(select(Scene).where(Scene.project_id == project_id)))
            .scalars()
            .all()
        )
        for s in scene_rows:
            if s.name == shot.scene_name:
                ref_images.extend(list(s.ref_image_ids or []))
        shot.ref_images = ref_images
        shot.status = "PROMPT_READY"

    await db.flush()
    return len(shots)
