/**
 * M4 合成厂 — 微动态提示词组装
 * 将分镜（动作 + 镜头语言）转换为可灵图生视频的微动态 prompt，
 * 强调"轻微运动、呼吸感"，避免大幅动作导致角色崩坏。
 */
import type { Shot } from "@/generated/prisma/client";

const MOVEMENT_CN: Record<string, string> = {
  static: "固定机位，几乎不动",
  push_in: "镜头缓慢推近",
  push: "镜头缓慢推近",
  pull_out: "镜头缓慢拉远",
  pull: "镜头缓慢拉远",
  pan_left: "镜头缓缓向左摇动",
  pan_right: "镜头缓缓向右摇动",
  pan: "镜头水平缓慢摇动",
  tilt_up: "镜头缓缓上摇",
  tilt_down: "镜头缓缓下摇",
  dolly: "镜头缓缓向前推进",
  orbit: "镜头环绕人物缓慢移动",
  handheld: "轻微手持抖动感",
  follow: "镜头跟随人物缓缓移动",
};

const ANGLE_CN: Record<string, string> = {
  low: "低角度仰拍",
  high: "高角度俯拍",
  top: "俯拍",
  eye: "平视",
  dutch: "倾斜视角",
};

const SIZE_CN: Record<string, string> = {
  close_up: "特写",
  close: "特写",
  medium_close: "近景",
  medium: "中景",
  wide: "远景",
  extreme_wide: "大全景",
};

/** 从镜头组装图生视频的微动态 prompt */
export function buildMotionPrompt(shot: Pick<Shot, "action" | "dialog" | "camera" | "sceneName">): string {
  const camera = (shot.camera ?? {}) as { angle?: string; movement?: string; shotSize?: string };
  const movement = MOVEMENT_CN[camera.movement ?? ""] ?? "镜头轻微缓慢运动";
  const angle = ANGLE_CN[camera.angle ?? ""] ?? "平视";
  const size = SIZE_CN[camera.shotSize ?? ""] ?? "中景";
  const dialogHint = dialogMotionHint(shot.dialog);

  const parts = [
    `${size}${angle}，${movement}`,
    shot.action ? `画面内容：${shot.action}` : "",
    "人物保持自然姿态，轻微呼吸起伏，发丝与衣角随动作自然飘动，眼神灵动",
    dialogHint,
    "动作连贯流畅，物理合理（重力/惯性自然），手指与五官不变形",
    "镜头运动舒缓克制，电影质感，光影连续稳定，画面清晰锐利",
    "不要大幅动作，不要表情突变，不要文字或水印，不要画面闪烁或跳变",
  ];
  return parts.filter(Boolean).join("。") + "。";
}

/** 台词语气 → 微动态强度（简短台词默认轻微，长台词适度） */
export function dialogMotionHint(dialog?: string | null): string {
  if (!dialog) return "";
  const len = dialog.length;
  if (len <= 12) return "说话时口型与手势轻微配合";
  if (len <= 40) return "说话时带适度的语气动作";
  return "说话时伴随自然的肢体与表情变化";
}
