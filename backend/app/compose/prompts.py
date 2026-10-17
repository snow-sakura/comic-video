"""视频微动态提示词组装

build_motion_prompt：镜头 → Agnes Video 微动态提示词
（轻微运动 / 呼吸感 / 口型配合，避免大幅动作与表情突变）。

camera 字段使用英文枚举 code（angle/movement/shotSize），
经 MOVEMENT_CN / ANGLE_CN / SIZE_CN 翻译为中文描述后填入 motion 模板。
"""

from __future__ import annotations

from app.prompts.registry import render_prompt
from app.json_utils import as_string, as_record

# 运镜 code → 中文描述
MOVEMENT_CN = {
    "static": "固定机位，几乎不动",
    "push_in": "镜头缓慢推近",
    "push": "镜头缓慢推近",
    "pull_out": "镜头缓慢拉远",
    "pull": "镜头缓慢拉远",
    "pan_left": "镜头缓缓向左摇动",
    "pan_right": "镜头缓缓向右摇动",
    "pan": "镜头水平缓慢摇动",
    "tilt_up": "镜头缓缓上摇",
    "tilt_down": "镜头缓缓下摇",
    "dolly": "镜头缓缓向前推进",
    "orbit": "镜头环绕人物缓慢移动",
    "handheld": "轻微手持抖动感",
    "follow": "镜头跟随人物缓缓移动",
}
# 视角 code → 中文描述
ANGLE_CN = {
    "low": "低角度仰拍",
    "high": "高角度俯拍",
    "top": "俯拍",
    "eye": "平视",
    "dutch": "倾斜视角",
}
# 景别 code → 中文描述
SIZE_CN = {
    "close_up": "特写",
    "close": "特写",
    "medium_close": "近景",
    "medium": "中景",
    "wide": "远景",
    "extreme_wide": "大全景",
}


def _cn_size(shot_size: str | None) -> str:
    return SIZE_CN.get(shot_size or "", "中景")


def _cn_angle(angle: str | None) -> str:
    return ANGLE_CN.get(angle or "", "平视")


def _cn_movement(movement: str | None) -> str:
    return MOVEMENT_CN.get(movement or "", "镜头轻微缓慢运动")


def _dialog_motion_hint(dialog: str) -> str:
    """按台词长度给出口型/肢体提示"""
    if not dialog:
        return ""
    n = len(dialog)
    if n <= 12:
        return "说话时口型与手势轻微配合"
    if n <= 40:
        return "说话时带适度的语气动作"
    return "说话时伴随自然的肢体与表情变化"


async def build_motion_prompt(shot: dict, project_id: str | None = None) -> str:
    """
    shot: { sceneName, camera: {angle, movement, shotSize}, action,
            dialog, dialogChar, dialogEmotion, duration }
    """
    camera = as_record(shot.get("camera"))
    dialog = as_string(shot.get("dialog"))
    movement = _cn_movement(camera.get("movement") if camera else "")
    angle = _cn_angle(camera.get("angle") if camera else "")
    size = _cn_size(camera.get("shotSize") if camera else "")
    dialog_hint = _dialog_motion_hint(dialog)

    return await render_prompt(
        "motion",
        {
            "size": size,
            "angle": angle,
            "movement": movement,
            "action": as_string(shot.get("action")),
            "dialogHint": dialog_hint,
        },
        project_id,
    )
