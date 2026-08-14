/**
 * 资产工厂 prompt 组装
 * 核心目标：视觉锚点可复现 —— 定妆照/空镜一旦生成并锁定（APPROVED），
 * 后续 M3 分镜出图将引用这些图作为参考图，保证角色/场景一致性。
 * 提示词文本已模板化：见 src/lib/prompts/registry.ts（项目覆盖 > 全局 > 内置默认）。
 */
import { renderPrompt } from "@/lib/prompts/registry";

export interface DesignAppearance {
  hair: string;
  costume: string;
  facialMarkers: string;
  body: string;
  style: string;
}

export interface DesignCharacter {
  name: string;
  role: string;
  gender: string | null;
  appearance: DesignAppearance;
  refImageIds: string[];
}

export interface DesignScene {
  name: string;
  description: string | null;
  mood: string | null;
  refImageIds: string[];
}

/** 全局风格锚点（暂以固定推荐风格为主，后续可从 project.style 扩展） */
export function styleAnchor(projectStyle?: Record<string, unknown> | null): string {
  const s = projectStyle;
  if (s && typeof s.styleDesc === "string" && s.styleDesc) return s.styleDesc;
  return "现代都市言情风，电影级光影，精致唯美，干净利落的构图，高细节，2.5D 动漫风格，柔和的色彩层次，背景虚化浅景深";
}

const ROLE_CN: Record<string, string> = {
  protagonist: "主角",
  antagonist: "反派",
  supporting: "配角",
  utility: "功能性角色",
};

const GENDER_CN: Record<string, string> = {
  male: "男性",
  female: "女性",
  unknown: "未知（按中性处理）",
};

/** 角色定妆照 prompt（标准正面半身像 + 姿态变体说明） */
export async function characterDesignPrompt(
  c: DesignCharacter,
  anchor: string,
  angle: "front" | "three-quarter" | "full",
  projectId?: string | null
): Promise<string> {
  const view =
    angle === "front"
      ? "正面全身定妆照，站立姿势，直视镜头，表情中性"
      : angle === "three-quarter"
        ? "四分之三侧面半身像，微侧身，自然姿态"
        : "全身像，侧面展示完整服装轮廓，人物从头到脚完整出现在画面内，头部上方与脚底下方保留少量留白，不可裁切身体任何部位";
  return renderPrompt(
    "character",
    {
      name: c.name,
      view,
      gender: GENDER_CN[c.gender ?? "unknown"] ?? "未知（按中性处理）",
      hair: c.appearance.hair,
      costume: c.appearance.costume,
      facialMarkers: c.appearance.facialMarkers,
      body: c.appearance.body,
      roleCN: ROLE_CN[c.role] ?? "功能性角色",
      charStyle: c.appearance.style,
      anchor,
    },
    projectId
  );
}

/** 场景空镜 prompt */
export async function sceneDesignPrompt(s: DesignScene, anchor: string, projectId?: string | null): Promise<string> {
  return renderPrompt(
    "scene",
    {
      name: s.name,
      mood: s.mood ? `，氛围基调：${s.mood}` : "",
      description: s.description ? `画面描述：${s.description}` : "",
      anchor,
    },
    projectId
  );
}

/** 道具 prompt */
export async function propDesignPrompt(name: string, desc: string, anchor: string, projectId?: string | null): Promise<string> {
  return renderPrompt(
    "prop",
    {
      name,
      desc: desc ? `（${desc}）` : "",
      anchor,
    },
    projectId
  );
}

/** 从场景情绪关键词推断 mood（供 Scene 表） */
export function inferMood(timeOrDesc: string): string | null {
  const t = timeOrDesc ?? "";
  if (/(夜|雨|昏暗|暗|阴)/.test(t)) return "阴郁悬疑";
  if (/(暖|阳光|清晨|白天|日)/.test(t)) return "温暖明亮";
  if (/(咖啡|餐厅|咖啡馆|室内)/.test(t)) return "温馨日常";
  if (/(废|旧|破|荒|雪|风)/.test(t)) return "冷峻苍凉";
  return null;
}
