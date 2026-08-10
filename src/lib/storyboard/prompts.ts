/**
 * 分镜车间 Prompt（M3）
 * 1) 分镜 Agent：把场景切分为镜头（LLM 结构化输出 + 回退）
 * 2) 7 维提示词：组装可复现的分镜出图提示词（引用锁定角色定妆照 / 场景空镜）
 */

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
  appearance: Record<string, string>;
}

/** 分镜 Agent prompt */
export function buildStoryboardPrompt(scene: StoryboardScene, chars: CharacterCard[], index: number, total: number): string {
  const charLines = chars
    .map((c) => `- ${c.name}（${c.role}）：发型「${c.appearance.hair ?? "待定"}」、服装「${c.appearance.costume ?? "待定"}」`)
    .join("\n");
  const dialogLines = scene.dialogs
    .map((d) => `【${d.char}·${d.emotion}】${d.text}`)
    .join("\n");
  return [
    `请为剧本中的一个场景切分镜头（场景 ${index + 1}/${total}），只输出 JSON。`,
    "",
    `## 场景信息`,
    `地点：${scene.location}｜时间：${scene.time}`,
    `在场角色：${scene.characters.join("、") || "无"}`,
    `画面动作：${scene.action}`,
    scene.dialogs.length > 0 ? `台词：\n${dialogLines}` : "无台词",
    "",
    `## 角色外观参考`,
    charLines || "（无角色）",
    "",
    `## 输出要求`,
    `输出 {"shots": [...]}，每个镜头包含：`,
    `- sceneName: 场景名`,
    `- camera: { angle: 平视|俯视|仰视|斜角, movement: 固定|推近|拉远|横移|跟随|环绕, shotSize: 特写|近景|中景|全景|远景 }`,
    `- action: 该镜头的画面动作描述（≤60字）`,
    `- dialog: 该镜头台词（若台词切分到多镜，按语义拆分；无则null）`,
    `- dialogChar: 说话角色名（无则null）`,
    `- dialogEmotion: 台词情绪（无则null）`,
    `- duration: 镜头时长秒数（有台词按语速≈4字/秒，无台词3-5秒）`,
    `要求：1-3 个镜头，按剧情节奏切分，不要遗漏关键动作与台词。`,
  ].join("\n");
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
  return {
    subject: opts.subject || (shot.dialogChar ? `${shot.dialogChar}（主体）` : "画面主体（按动作描述）"),
    action: shot.action,
    environment: opts.environment || shot.sceneName,
    camera: `${shot.camera.angle}、${shot.camera.movement}、${shot.camera.shotSize}`,
    lighting: opts.lighting || "自然电影级光线",
    style: opts.styleAnchor,
    extra: opts.negative || "画面干净，无文字，无水印",
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

/** 场景氛围 → 光线提示词 */
export function lightingFor(time: string | null | undefined, mood: string | null | undefined): string {
  const t = `${time ?? ""}${mood ?? ""}`;
  if (/(夜|夜晚|深夜)/.test(t)) return "夜晚氛围，冷暖对比光，霓虹或月光照明";
  if (/(黄昏|傍晚|夕阳|日落)/.test(t)) return "黄昏暖金色逆光，轮廓光";
  if (/(清晨|黎明)/.test(t)) return "清晨柔光，低角度暖光";
  if (/(雨|雨天)/.test(t)) return "阴雨天气，柔和漫射光，湿润反光";
  if (/(阴|昏暗|暗)/.test(t)) return "昏暗氛围，局部点光源，高对比";
  if (/(室内|咖啡|餐厅|办公室)/.test(t)) return "室内自然窗光 + 环境补光";
  return "自然电影级光线";
}
