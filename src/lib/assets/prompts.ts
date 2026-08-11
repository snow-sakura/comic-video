/**
 * 资产工厂 prompt 组装
 * 核心目标：视觉锚点可复现 —— 定妆照/空镜一旦生成并锁定（APPROVED），
 * 后续 M3 分镜出图将引用这些图作为参考图，保证角色/场景一致性。
 */

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

/** 角色定妆照 prompt（标准正面半身像 + 姿态变体说明） */
export function characterDesignPrompt(c: DesignCharacter, anchor: string, angle: "front" | "three-quarter" | "full"): string {
  const view =
    angle === "front"
      ? "正面全身定妆照，站立姿势，直视镜头，表情中性"
      : angle === "three-quarter"
        ? "四分之三侧面半身像，微侧身，自然姿态"
        : "全身像，侧面展示完整服装轮廓";
  return [
    `${c.name}的角色设计定妆照，${view}`,
    `外貌特征：发型「${c.appearance.hair}」；服装「${c.appearance.costume}」；面部特征「${c.appearance.facialMarkers}」；体型「${c.appearance.body}」`,
    `角色身份：${c.role === "protagonist" ? "主角" : c.role === "antagonist" ? "反派" : c.role === "supporting" ? "配角" : "功能性角色"}`,
    `整体风格：${c.appearance.style}`,
    `全局画风：${anchor}`,
    "纯色或浅色干净背景，人物完整可见，柔和顶光 + 正面补光，人物五官清晰对称，肢体比例自然",
    "服装材质细节明确（褶皱/纹理/配饰），发型发丝层次清晰",
    "无文字，无水印，无多余人物，无 logo",
  ].join("\n");
}

/** 场景空镜 prompt */
export function sceneDesignPrompt(s: DesignScene, anchor: string): string {
  const mood = s.mood ? `，氛围基调：${s.mood}` : "";
  return [
    `场景空镜：${s.name}${mood}`,
    s.description ? `画面描述：${s.description}` : "",
    "无人物的纯环境镜头，光线与色调契合氛围，电影级构图",
    "纵深层次清晰：前景/中景/背景三层分明，透视准确，材质细节丰富",
    `全局画风：${anchor}`,
    "无文字，无水印",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 道具 prompt */
export function propDesignPrompt(name: string, desc: string, anchor: string): string {
  return [
    `道具设计图：${name}${desc ? `（${desc}）` : ""}`,
    "产品展示角度，干净背景，材质细节清晰",
    `全局画风：${anchor}`,
    "无文字，无水印",
  ].join("\n");
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
