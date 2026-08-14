/**
 * 分镜车间 Prompt（M3）
 * 1) 分镜 Agent：把场景切分为镜头（LLM 结构化输出 + 回退）
 * 2) 7 维提示词：组装可复现的分镜出图提示词（引用锁定角色定妆照 / 场景空镜）
 * 分镜 Agent 提示词已模板化：见 src/lib/prompts/registry.ts（项目覆盖 > 全局 > 内置默认）。
 */
import { renderPrompt } from "@/lib/prompts/registry";

export interface StoryboardScene {
  location: string;
  time: string;
  characters: string[];
  action: string;
  dialogs: { char: string; text: string; emotion: string }[];
}

export interface ShotSpec {
  sceneName: string;
  camera: { angle: string; movement: string; shotSize: string };
  action: string;
  dialog: string | null;
  dialogChar: string | null;
  dialogEmotion: string | null;
  duration: number;
}

export interface CharacterCard {
  name: string;
  role: string;
  gender?: string | null;
  appearance: Record<string, string>;
}

const GENDER_CN: Record<string, string> = {
  male: "男",
  female: "女",
  unknown: "性别未知",
};

/** 分镜 Agent prompt */
export async function buildStoryboardPrompt(
  scene: StoryboardScene,
  chars: CharacterCard[],
  index: number,
  total: number,
  projectId?: string | null
): Promise<string> {
  const charLines = chars
    .map(
      (c) =>
        `- ${c.name}（${c.role}${c.gender && GENDER_CN[c.gender] ? `·${GENDER_CN[c.gender]}` : ""}）：发型「${c.appearance.hair ?? "待定"}」、服装「${c.appearance.costume ?? "待定"}」、标志物「${c.appearance.facialMarkers ?? "待定"}」`
    )
    .join("\n");
  const dialogLines = scene.dialogs
    .map((d) => `【${d.char}·${d.emotion}】${d.text}`)
    .join("\n");
  return renderPrompt(
    "storyboard",
    {
      index: String(index + 1),
      total: String(total),
      sceneLocation: scene.location,
      sceneTime: scene.time,
      sceneChars: scene.characters.join("、") || "无",
      sceneAction: scene.action,
      sceneDialogs: scene.dialogs.length > 0 ? `台词：\n${dialogLines}` : "无台词",
      charLines: charLines || "（无角色）",
    },
    projectId
  );
}

/** 分镜回退：每场景一个中景固定镜头 */
export function fallbackShots(scene: StoryboardScene): ShotSpec[] {
  const d = scene.dialogs[0];
  const text = d?.text ?? "";
  const duration = text ? Math.max(3, Math.ceil(text.length / 4)) : 4;
  return [
    {
      sceneName: scene.location,
      camera: { angle: "平视", movement: "固定", shotSize: "中景" },
      action: scene.action.slice(0, 80) || `${scene.location}的环境镜头`,
      dialog: d?.text ?? null,
      dialogChar: d?.char ?? null,
      dialogEmotion: d?.emotion ?? null,
      duration,
    },
  ];
}

/** 7 维提示词 */
export interface Prompt7 {
  subject: string; // ① 主体人物
  action: string; // ② 动作表情
  environment: string; // ③ 场景环境
  camera: string; // ④ 镜头语言
  lighting: string; // ⑤ 光线氛围
  style: string; // ⑥ 画风
  extra: string; // ⑦ 画面附加
}

/** 台词情绪 → 色板基调（供 7 维提示词组装） */
export function emotionPalette(emotion?: string | null): string {
  const e = `${emotion ?? ""}`;
  if (/(悲伤|哭泣|绝望|泪)/.test(e)) return "冷蓝色调，低饱和，画面带微弱的雨雾感";
  if (/(愤怒|激动|争吵|爆发)/.test(e)) return "暖橙红调，高对比，明暗交界锐利";
  if (/(紧张|害怕|恐惧|焦虑)/.test(e)) return "青灰色调，压低曝光，四周渐暗";
  if (/(惊喜|惊讶|震惊)/.test(e)) return "明亮暖调，高光点缀，色彩饱和度提升";
  if (/(温柔|甜蜜|爱|告白|温暖)/.test(e)) return "樱花粉暖调，柔和漫射光，梦幻光斑";
  if (/(冷漠|冷静|平淡|平静)/.test(e)) return "中性灰调，简洁留白，情绪克制";
  return "";
}

export function buildPrompt7(
  shot: ShotSpec,
  opts: {
    subject?: string; // 已组装的画面主体（角色名+外观）
    environment?: string; // 场景描述
    lighting?: string; // 光线氛围
    styleAnchor: string;
    negative?: string;
  }
): Prompt7 {
  const palette = emotionPalette(shot.dialogEmotion);
  return {
    subject: opts.subject || (shot.dialogChar ? `${shot.dialogChar}（主体）` : "画面主体（按动作描述）"),
    action: shot.action,
    environment: opts.environment || shot.sceneName,
    camera: `${shot.camera.angle}、${shot.camera.movement}、${shot.camera.shotSize}`,
    lighting: opts.lighting || (palette ? `${palette}，自然电影级光线` : "自然电影级光线"),
    style: opts.styleAnchor,
    extra: [palette ? `色彩基调：${palette}` : "", opts.negative || "画面干净，无文字，无水印"].filter(Boolean).join("，"),
  };
}

/** 组装完整出图提示词 */
export function assembleFinalPrompt(p7: Prompt7): string {
  return [
    `${p7.subject}，${p7.action}`,
    `场景：${p7.environment}`,
    `镜头：${p7.camera}`,
    `光线氛围：${p7.lighting}`,
    `画风：${p7.style}`,
    p7.extra,
  ].join("\n");
}

/** 场景氛围 → 光线提示词（time 可传场景时间，mood 可传场景情绪/地点） */
export function lightingFor(time: string | null | undefined, mood: string | null | undefined): string {
  const t = `${time ?? ""}${mood ?? ""}`;
  if (/(夜|夜晚|深夜)/.test(t)) return "夜晚氛围，冷暖对比光，霓虹或月光照明";
  if (/(黄昏|傍晚|夕阳|日落)/.test(t)) return "黄昏暖金色逆光，轮廓光";
  if (/(清晨|黎明|薄雾|晨光)/.test(t)) return "清晨柔光，低角度暖光，轻微雾气";
  if (/(雨|雨天)/.test(t)) return "阴雨天气，柔和漫射光，湿润反光";
  if (/(雪|雪天)/.test(t)) return "雪地冷白反光，柔和清冷光线";
  if (/(阴|昏暗|暗)/.test(t)) return "昏暗氛围，局部点光源，高对比";
  if (/(室内|咖啡|餐厅|办公室|教室|医院)/.test(t)) return "室内自然窗光 + 环境补光";
  if (/(公园|森林|湖边|海边|校园)/.test(t)) return "自然天光，通透空气感，植物反光";
  return "自然电影级光线";
}
