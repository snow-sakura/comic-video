/**
 * M4 合成厂 — 微动态提示词组装
 * 将分镜（动作 + 镜头语言）转换为可灵图生视频的微动态 prompt，
 * 强调"轻微运动、呼吸感"，避免大幅动作导致角色崩坏。
 * 提示词文本已模板化：见 src/lib/prompts/registry.ts（项目覆盖 > 全局 > 内置默认）。
 */
import type { Shot } from "@/generated/prisma/client";
import { renderPrompt } from "@/lib/prompts/registry";

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
export async function buildMotionPrompt(
  shot: Pick<Shot, "action" | "dialog" | "camera" | "sceneName">,
  projectId?: string | null
): Promise<string> {
  const camera = (shot.camera ?? {}) as { angle?: string; movement?: string; shotSize?: string };
  const movement = MOVEMENT_CN[camera.movement ?? ""] ?? "镜头轻微缓慢运动";
  const angle = ANGLE_CN[camera.angle ?? ""] ?? "平视";
  const size = SIZE_CN[camera.shotSize ?? ""] ?? "中景";
  const dialogHint = dialogMotionHint(shot.dialog);

  const prompt = await renderPrompt(
    "motion",
    {
      size,
      angle,
      movement,
      action: shot.action ?? "",
      dialogHint,
    },
    projectId
  );
  return prompt
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/** 台词语气 → 微动态强度（简短台词默认轻微，长台词适度） */
export function dialogMotionHint(dialog?: string | null): string {
  if (!dialog) return "";
  const len = dialog.length;
  if (len <= 12) return "说话时口型与手势轻微配合";
  if (len <= 40) return "说话时带适度的语气动作";
  return "说话时伴随自然的肢体与表情变化";
}
