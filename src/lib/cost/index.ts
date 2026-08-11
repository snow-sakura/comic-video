/**
 * 费用估算（P1-2）— 只做估算展示，不实际扣费
 *
 * 原则：
 *  - 未配置真实 Key（mock provider）一律记 0 元
 *  - LLM 按字符估算 token（中文 1 字 ≈ 1 token，非中文 4 字符 ≈ 1 token）
 *  - 图片/视频/语音按行业参考单价计次（估算值，仅用于展示）
 *  - 估算结果写入 GenTask.cost（Float，元）
 */
import { prisma } from "@/lib/db";
import { getSetting } from "@/lib/providers/settings";

// ========== Token 估算 ==========

/** 估算文本 token 数：中文 1:1，其余 4 字符:1（粗略但足够展示） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

// ========== 单价表（元 / 千 token，参考价，仅估算） ==========

const LLM_PRICES: Record<string, { input: number; output: number }> = {
  glm: { input: 0.0, output: 0.0 }, // glm-4.7-flash 免费档（如收费请按实际调整）
  deepseek: { input: 0.002, output: 0.008 }, // deepseek-chat
  doubao: { input: 0.002, output: 0.008 }, // doubao-seed
};

/** 单张图片估算价（元） */
export const IMAGE_PRICE = 0.15;
/** 单个视频估算价（元） */
export const VIDEO_PRICE = 2.0;
/** 语音每分钟估算价（元） */
export const AUDIO_PRICE_PER_MIN = 0.5;

// ========== 任务费用估算与落库 ==========

export interface CostUnits {
  kind: "llm" | "image" | "video" | "audio" | "compose";
  /** llm 专用：输入/输出字符数 */
  inputChars?: number;
  outputChars?: number;
  /** image/video 数量 */
  count?: number;
  /** audio 时长（秒） */
  durationSec?: number;
}

/** 判断某类 provider 是否 mock（mock 不计费） */
async function isMock(kind: CostUnits["kind"]): Promise<boolean> {
  const key =
    kind === "llm"
      ? "text.provider"
      : kind === "image"
        ? "image.provider"
        : kind === "video"
          ? "video.provider"
          : "tts.engine";
  const id = ((await getSetting<string>(key)) ?? "").toLowerCase();
  return id === "" || id.includes("mock");
}

/** 按任务类型估算费用（元）；provider 为 mock 时返回 0 */
export async function estimateCost(units: CostUnits): Promise<number> {
  if (await isMock(units.kind)) return 0;
  switch (units.kind) {
    case "llm": {
      const provider = ((await getSetting<string>("text.provider")) ?? "").toLowerCase();
      const p = LLM_PRICES[provider] ?? LLM_PRICES["glm"]!;
      const inputTokens = estimateTokens(units.inputChars ? String(units.inputChars) : "");
      // outputChars 传的是字符数，直接估算
      const outputTokens = units.outputChars ? Math.ceil(units.outputChars / 1.5) : 0;
      return ((inputTokens * p.input) + (outputTokens * p.output)) / 1000;
    }
    case "image":
      return (units.count ?? 0) * IMAGE_PRICE;
    case "video":
      return (units.count ?? 0) * VIDEO_PRICE;
    case "audio":
      return ((units.durationSec ?? 0) / 60) * AUDIO_PRICE_PER_MIN;
    case "compose":
      return 0;
  }
}

/** 估算并写入 GenTask.cost（失败静默，不影响任务主流程） */
export async function recordCost(taskId: string, units: CostUnits): Promise<void> {
  try {
    const cost = await estimateCost(units);
    await prisma.genTask.update({ where: { id: taskId }, data: { cost } }).catch(() => {});
  } catch {
    // 忽略估算失败
  }
}
