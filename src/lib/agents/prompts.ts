/**
 * 剧本工坊 三 Agent Prompt 构造
 * 设计原则：精确的 JSON Schema 约束 + 剧情创作引导，输出可直接落库。
 * 提示词文本已模板化：见 src/lib/prompts/registry.ts（项目覆盖 > 全局 > 内置默认）。
 */
import { renderPrompt } from "@/lib/prompts/registry";

/** 性别枚举 → 中文词（供角色卡/大纲描述） */
export function genderCN(g?: string | null): string {
  if (g === "male") return "男";
  if (g === "female") return "女";
  return "性别未知";
}

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
export async function buildExtractPrompt(
  novelDigest: string,
  fullText: string,
  projectId?: string | null
): Promise<string> {
  return renderPrompt(
    "extract",
    {
      jsonSchema: JSON.stringify(
        {
          logline: "一句话核心梗概（30字内，含核心冲突）",
          worldView: "世界观简述（时代/地点/超自然设定，80字内）",
          genre: "题材标签数组，如 [\"都市\",\"奇幻\"]",
          characters: [
            {
              name: "角色名（最常用称呼，同一人物多种叫法须合并）",
              gender: "male | female | unknown（必须给，按剧情证据推断：他/她、称谓、外貌描写）",
              role: "protagonist | supporting | antagonist | utility（主角/配角/反派/功能性）",
              appearance: { hair: "发型发色（与其他角色区分）", costume: "日常服饰（含主色调，与其他角色区分）", facialMarkers: "面部特征", body: "体型", style: "整体风格" },
              personality: { habits: "习惯动作", emotionalReactions: "情绪反应模式", speechStyle: "说话风格", psychology: "心理动机" },
              voiceName: "建议的配音音色描述（3-10字），必须含明确性别词与气质词，如：清亮少女音、低沉威严男声、沙哑磁性男声、慈祥老妇声、温和沉稳青年男声。可选的 voiceId 枚举：confucius-feminine（柔美女声）/ confucius-clear（清朗少年男声）/ confucius-mature-f（慈祥年长女声）/ confucius-deep（低沉威严男声）/ confucius-raspy（沙哑浑厚男声）/ confucius-mellow（温和沉稳男声）",
              voiceId: "（可选）音色枚举 ID，仅从 confucius-feminine / confucius-clear / confucius-mature-f / confucius-deep / confucius-raspy / confucius-mellow 中选择，与 voiceName 和 gender 保持一致（女角色不得选 male 音色）；不确定时省略，由系统按 voiceName 匹配",
            },
          ],
        },
        null,
        2
      ),
      novelDigest,
      fullText: fullText.slice(0, 12000),
    },
    projectId
  );
}

/** Agent 2：分集大纲 */
export async function buildOutlinePrompt(
  novelDigest: string,
  logline: string,
  worldView: string,
  characters: { name: string; role: string; gender?: string | null }[],
  episodeCount: number,
  projectId?: string | null
): Promise<string> {
  return renderPrompt(
    "outline",
    {
      jsonSchema: JSON.stringify(
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
      logline,
      worldView,
      characters: characters.map((c) => `${c.name}(${c.role}${c.gender ? `·${genderCN(c.gender)}` : ""})`).join("、"),
      episodeCount: String(episodeCount),
      novelDigest,
    },
    projectId
  );
}

/** Agent 3：单集分镜剧本 */
export async function buildEpisodeScriptPrompt(
  novelDigest: string,
  characters: { name: string; role: string; gender?: string | null; appearance: Record<string, string>; personality: Record<string, string> }[],
  outline: OutlineEpisode,
  perChapterText: string,
  projectId?: string | null
): Promise<string> {
  const charDesc = characters
    .map(
      (c) =>
        `${c.name}（${c.role}${c.gender ? `·${genderCN(c.gender)}` : ""}）：外貌 ${JSON.stringify(c.appearance)}；性格 ${JSON.stringify(c.personality)}`
    )
    .join("\n");
  return renderPrompt(
    "script",
    {
      jsonSchema: JSON.stringify(
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
      number: String(outline.number),
      charDesc,
      outlineJson: JSON.stringify(outline, null, 2),
      perChapterText: perChapterText.slice(0, 6000),
    },
    projectId
  );
}
