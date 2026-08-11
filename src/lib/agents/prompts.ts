/**
 * 剧本工坊 三 Agent Prompt 构造
 * 设计原则：精确的 JSON Schema 约束 + 剧情创作引导，输出可直接落库。
 */

export interface OutlineEpisode {
  number: number;
  title: string;
  hookEnd: string; // 集尾悬念
  summary: string; // 本集剧情概述
  scenes: { location: string; time: string; summary: string }[]; // 场景列表（剧本细化时用）
}

export interface EpisodeScript {
  number: number;
  title: string;
  hookEnd: string;
  scenes: {
    location: string; // 场景地点，如 "雨夜小巷"
    time: string; // 时间，如 "夜 / 雨"
    characters: string[]; // 在场角色
    action: string; // 画面动作描述
    dialogs: { char: string; text: string; emotion: string }[]; // 台词（可空）
  }[];
}

/** Agent 1：角色提炼与世界观 */
export function buildExtractPrompt(novelDigest: string, fullText: string): string {
  return [
    "你是专业的漫剧编剧统筹。阅读小说内容，提炼出适合改编为漫剧（AI 生成短视频）的要素。",
    "",
    "## 输出要求",
    "严格输出 JSON（不要 markdown 代码块），结构如下：",
    JSON.stringify(
      {
        logline: "一句话核心梗概（30字内，含核心冲突）",
        worldView: "世界观简述（时代/地点/超自然设定，80字内）",
        genre: "题材标签数组，如 [\"都市\",\"奇幻\"]",
        characters: [
          {
            name: "角色名",
            role: "protagonist | supporting | antagonist | utility（主角/配角/反派/功能性）",
            appearance: { hair: "发型发色", costume: "日常服饰（含主色调）", facialMarkers: "面部特征", body: "体型", style: "整体风格" },
            personality: { habits: "习惯动作", emotionalReactions: "情绪反应模式", speechStyle: "说话风格", psychology: "心理动机" },
            voiceName: "建议的配音音色描述，如：清亮少女音 / 低沉男声，含语速与音调倾向",
          },
        ],
      },
      null,
      2
    ),
    "",
    "## 要求",
    "- 提炼 4-8 个关键角色，主角必须出现；每项外貌/性格描述用 10-30 字，具体可被 AI 绘图/TTS 使用",
    "- 外貌描述聚焦可绘制的视觉细节：发型发色、服饰主色调、标志性物件（配饰/武器/随身物），同一角色的视觉锚点全篇统一",
    "- 每个角色给 1 个「色彩主题」暗示（如：冷白/樱粉/墨青），便于后续分镜光线与色板一致",
    "- voiceName 描述要可被 TTS 音色匹配：音色类型 + 语速（快/慢）+ 音调（高/低）+ 情绪基调",
    "- 负面约束：避免真实历史人物/在世名人肖像式描述，避免过度暴露或血腥猎奇设定",
    "- logline 要体现人物 + 目标 + 阻碍",
    "",
    "## 小说内容",
    `【摘要】\n${novelDigest}\n\n【全文】\n${fullText.slice(0, 12000)}`,
  ].join("\n");
}

/** Agent 2：分集大纲 */
export function buildOutlinePrompt(
  novelDigest: string,
  logline: string,
  worldView: string,
  characters: { name: string; role: string }[],
  episodeCount: number
): string {
  return [
    "你是漫剧总编剧。基于小说提炼的要素，规划整部漫剧的分集大纲（每集 2-4 分钟微短剧）。",
    "",
    "## 输出要求",
    "严格输出 JSON（不要 markdown 代码块），结构如下：",
    JSON.stringify(
      {
        logline: "一句话核心梗概（与输入保持一致）",
        episodes: [
          {
            number: 1,
            title: "集标题（8字内，吸睛）",
            hookEnd: "集尾悬念/钩子（30字内，必须制造追剧动机）",
            summary: "本集剧情概述（100字内）",
            scenes: [{ location: "场景地点", time: "时间/氛围", summary: "本场景发生的事（40字内）" }],
          },
        ],
      },
      null,
      2
    ),
    "",
    `## 设定`,
    `梗概：${logline}\n世界观：${worldView}\n主要角色：${characters.map((c) => `${c.name}(${c.role})`).join("、")}`,
    "",
    `## 要求`,
    `- 共 ${episodeCount} 集，第 1 集快速建立人物与冲突，最后一集收束核心悬念`,
    `- 每集 3-6 个场景，场景变化要适合 AI 视频生成（室内外切换合理）`,
    `- hookEnd 是本集最后 3 秒的钩子：悬念/反转/情感冲击，用于引导观众看下一集`,
    `- 单集情绪曲线要有起伏：开场小钩子 → 中段推进（冲突/甜蜜/转折）→ 结尾大悬念，避免平铺直叙`,
    `- 每集至少 1 个「高情绪点」（强冲突或强情感场景），并标注在 summary 中`,
    `- 场景 time 字段要给出可出图的光线与氛围词（如：夜·雨 / 黄昏·逆光 / 清晨·薄雾），供分镜阶段直接复用`,
    "",
    `## 小说摘要`,
    novelDigest,
  ].join("\n");
}

/** Agent 3：单集分镜剧本 */
export function buildEpisodeScriptPrompt(
  novelDigest: string,
  characters: { name: string; role: string; appearance: Record<string, string>; personality: Record<string, string> }[],
  outline: OutlineEpisode,
  perChapterText: string
): string {
  const charDesc = characters
    .map((c) => `${c.name}（${c.role}）：外貌 ${JSON.stringify(c.appearance)}；性格 ${JSON.stringify(c.personality)}`)
    .join("\n");
  return [
    `你是漫剧分集编剧。将第 ${outline.number} 集大纲扩展为可直接用于 AI 分镜/出图/配音的完整剧本。`,
    "",
    "## 输出要求",
    "严格输出 JSON（不要 markdown 代码块），结构如下：",
    JSON.stringify(
      {
        number: outline.number,
        title: "集标题",
        hookEnd: "集尾悬念",
        scenes: [
          {
            location: "场景地点（如：雨夜小巷）",
            time: "时间/氛围（如：夜·雨）",
            characters: ["在场角色名"],
            action: "画面动作描述（80-150字，含环境细节、角色动作、景别建议，供 AI 出图）",
            dialogs: [{ char: "说话角色名", text: "台词", emotion: "情绪：平静|激动|愤怒|悲伤|惊喜|紧张|冷漠|温柔" }],
          },
        ],
      },
      null,
      2
    ),
    "",
    "## 要求",
    "- 按大纲场景逐个展开，每场景的 action 要有视觉细节（光线、服装、环境物），可被 AI 绘图直接使用",
    "- 台词口语化、短句为主，适合 TTS 朗读；每个场景 0-4 句台词，纯动作场景可为空数组",
    "- 台词规则：单句 ≤30 字、避免生僻字/长定语/引号内套引号，多用口语词（哦/呀/哼/罢了）；标点以。？！为主",
    "- action 遵循「光线 + 人物动作 + 环境细节 + 景别建议」结构，供分镜 Agent 直接切镜头",
    "- 全剧贯穿角色一致性：称呼、性格、语气与角色卡一致",
    "- 场景情绪与 action 匹配：紧张场景给急促动作，温情场景给细腻动作（眼神/手部细节）",
    "- 集尾场景必须落到 hookEnd 悬念上",
    "",
    "## 角色卡",
    charDesc,
    "",
    "## 本集大纲",
    JSON.stringify(outline, null, 2),
    "",
    "## 参考原文",
    perChapterText.slice(0, 6000),
  ].join("\n");
}
