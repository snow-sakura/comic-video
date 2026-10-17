"""资产提示词组装"""

from __future__ import annotations

from app.prompts.registry import render_prompt
from app.json_utils import as_string

ROLE_CN = {
    "protagonist": "主角",
    "antagonist": "反派",
    "supporting": "配角",
    "utility": "功能性角色",
}

GENDER_CN = {
    "male": "男性",
    "female": "女性",
    "unknown": "未知（按中性处理）",
}

DEFAULT_ANCHOR = "现代都市言情风，电影级光影，精致唯美，干净利落的构图，高细节，2.5D 动漫风格，柔和的色彩层次，背景虚化浅景深"


def style_anchor(project_style: dict | None = None) -> str:
    s = project_style or {}
    desc = s.get("styleDesc")
    if isinstance(desc, str) and desc:
        return desc
    return DEFAULT_ANCHOR


async def character_design_prompt(
    c: dict, anchor: str, angle: str = "front", project_id: str | None = None
) -> str:
    view = {
        "front": "正面全身定妆照，站立姿势，直视镜头，表情中性",
        "three-quarter": "四分之三侧面半身像，微侧身，自然姿态",
        "full": "全身像，侧面展示完整服装轮廓，人物从头到脚完整出现在画面内，头部上方与脚底下方保留少量留白，不可裁切身体任何部位",
    }.get(angle, "正面全身定妆照")
    appearance = c.get("appearance") or {}
    return await render_prompt(
        "character",
        {
            "name": as_string(c.get("name")),
            "view": view,
            "gender": GENDER_CN.get(
                as_string(c.get("gender"), "unknown"), GENDER_CN["unknown"]
            ),
            "hair": as_string(appearance.get("hair"), "待定"),
            "costume": as_string(appearance.get("costume"), "待定"),
            "facialMarkers": as_string(appearance.get("facialMarkers"), "待定"),
            "body": as_string(appearance.get("body"), "待定"),
            "roleCN": ROLE_CN.get(as_string(c.get("role"), "utility"), "功能性角色"),
            "charStyle": as_string(appearance.get("style"), "待定"),
            "anchor": anchor,
        },
        project_id,
    )


async def scene_design_prompt(
    s: dict, anchor: str, project_id: str | None = None
) -> str:
    mood = s.get("mood")
    desc = s.get("description")
    return await render_prompt(
        "scene",
        {
            "name": as_string(s.get("name")),
            "mood": f"，氛围基调：{mood}" if mood else "",
            "description": f"画面描述：{desc}" if desc else "",
            "anchor": anchor,
        },
        project_id,
    )


async def prop_design_prompt(
    name: str, desc: str, anchor: str, project_id: str | None = None
) -> str:
    return await render_prompt(
        "prop",
        {
            "name": name,
            "desc": f"（{desc}）" if desc else "",
            "anchor": anchor,
        },
        project_id,
    )


def infer_mood(time_or_desc: str) -> str | None:
    t = time_or_desc or ""
    import re

    if re.search(r"(夜|雨|昏暗|暗|阴)", t):
        return "阴郁悬疑"
    if re.search(r"(暖|阳光|清晨|白天|日)", t):
        return "温暖明亮"
    if re.search(r"(咖啡|餐厅|咖啡馆|室内)", t):
        return "温馨日常"
    if re.search(r"(废|旧|破|荒|雪|风)", t):
        return "冷峻苍凉"
    return None
