/**
 * 提示词模板注册表（提示词工程可视化配置引擎）
 *
 * 三级解析优先级：项目级覆盖 > 全局模板 > 代码内置默认。
 * - scope=global  ：设置页管理，覆盖所有小说
 * - scope=project ：项目页管理，仅适用某小说（结合剧情定制）
 * - 内置默认       ：与旧版硬编码提示词完全一致，未配置时行为不变
 *
 * 模板正文使用 {变量名} 占位符，渲染时由调用方传入变量值。
 */
import { prisma } from "@/lib/db";

// ========== 类型 ==========

export type PromptKey =
  | "extract" // 角色提炼与世界观（Agent 1）
  | "outline" // 分集大纲（Agent 2）
  | "script" // 单集分镜剧本（Agent 3）
  | "storyboard" // 分镜切分
  | "character" // 角色定妆照
  | "scene" // 场景空镜
  | "prop" // 道具设计图
  | "motion"; // 视频微动态

export interface PromptVarDef {
  name: string;
  desc: string;
}

export interface PromptTemplateDef {
  key: PromptKey;
  name: string;
  desc: string;
  variables: PromptVarDef[];
  defaultTemplate: string;
}

export interface PromptTemplateRow {
  key: PromptKey;
  scope: "global" | "project";
  projectId: string | null;
  name: string;
  template: string;
  enabled: boolean;
}

// ========== 内置默认模板（与旧版硬编码提示词逐字一致） ==========

const EXTRACT_DEFAULT = `你是专业的漫剧编剧统筹。阅读小说内容，提炼出适合改编为漫剧（AI 生成短视频）的要素。

## 输出要求
严格输出 JSON（不要 markdown 代码块），结构如下：
{jsonSchema}

## 角色提炼标准（严格遵循）
- **只提炼"人物"角色**：必须是推动剧情/有台词/被他人明确称呼的**具体个人**
- **坚决排除非人物**：组织名（如"唐家""唐门""青龙帮"）、地名、建筑、物品、动物（除非拟人化且参与对话）、时间概念、抽象词汇一律不得提炼为角色
- 角色数量 4-8 个：主角 1 名 + 重要配角/反派 2-4 名 + 有存在感的功能角色若干；宁缺毋滥，不确定的角色不要列入
- 同一人物在不同章节的多种称呼（名/字/绰号/职位）必须合并为一个角色，name 用最常用称呼
- **gender 必须给出**：male / female / unknown 三选一，根据剧情证据（"他/她"、称谓"小姐/公子/夫人/先生"、亲属关系、外貌描写）推断；无法判断才用 unknown
- 每个角色给出**互不相同的视觉锚点**：发型发色、服装主色调、标志性物件（配饰/武器/随身物）都必须与其他角色明显区分，禁止两个角色雷同（如都是"深色中长发+现代日常服饰"属于不合格）
- 主角与反派在服装色系上要形成对立（如冷色 vs 暖色），便于画面识别
- 外貌/性格每项描述 10-30 字，必须具体可被 AI 绘图/TTS 使用，禁止"待定"或模板化占位
- voiceName 必须提供：音色类型 + 性别词 + 语速（快/慢）+ 音调（高/低）+ 情绪基调；并优先给出与 gender 一致的 voiceId 枚举（见 schema 内枚举说明）
- 每个角色给 1 个「色彩主题」暗示（如：冷白/樱粉/墨青），便于后续分镜光线与色板一致
- 负面约束：避免真实历史人物/在世名人肖像式描述，避免过度暴露或血腥猎奇设定
- logline 要体现人物 + 目标 + 阻碍

## 小说内容
【摘要】
{novelDigest}

【全文】
{fullText}`;

const OUTLINE_DEFAULT = `你是漫剧总编剧。基于小说提炼的要素，规划整部漫剧的分集大纲（每集 2-4 分钟微短剧）。

## 输出要求
严格输出 JSON（不要 markdown 代码块），结构如下：
{jsonSchema}

## 设定
梗概：{logline}
世界观：{worldView}
主要角色：{characters}

## 要求
- 共 {episodeCount} 集，第 1 集快速建立人物与冲突，最后一集收束核心悬念
- **角色绑定**：每集剧情必须围绕{characters}中的角色展开，禁止引入角色卡之外的"工具人"作为剧情主轴；角色戏份分配要均衡主线人物
- **场景地点差异化**：每集 3-6 个场景；同集内相邻场景地点不得重复（如"雨夜小巷"后必须换地点）；所有集数的场景 location 要给出**具体可出图的地点名称**（如"雨夜·青石巷""黄昏·教学楼天台"），禁止使用"主线场景""未知场景"等占位
- 场景变化要适合 AI 视频生成（室内外切换合理，夜间/白天/黄昏光线交替）
- hookEnd 是本集最后 3 秒的钩子：悬念/反转/情感冲击，用于引导观众看下一集
- 单集情绪曲线要有起伏：开场小钩子 → 中段推进（冲突/甜蜜/转折）→ 结尾大悬念，避免平铺直叙
- 每集至少 1 个「高情绪点」（强冲突或强情感场景），并标注在 summary 中
- 场景 time 字段要给出可出图的光线与氛围词（如：夜·雨 / 黄昏·逆光 / 清晨·薄雾），供分镜阶段直接复用

## 小说摘要
{novelDigest}`;

const SCRIPT_DEFAULT = `你是漫剧分集编剧。将第 {number} 集大纲扩展为可直接用于 AI 分镜/出图/配音的完整剧本。

## 输出要求
严格输出 JSON（不要 markdown 代码块），结构如下：
{jsonSchema}

## 角色卡
{charDesc}

## 本集大纲
{outlineJson}

## 要求
- **场景绑定**：场景列表必须覆盖本集大纲中的全部场景，location 与大纲场景一致（可微调细化）；禁止跳过大纲场景，也禁止新增与大纲无关的场景
- **角色绑定（严格）**：scenes[].characters 和 dialogs[].char 只能来自上面角色卡中的人物（用角色卡中的标准名字）；禁止虚构角色卡之外的人物，禁止用"他/她/某人"代替
- 台词符合角色卡的性别与性格：称呼（他/她、先生/小姐）与角色 gender 一致，语气与 speechStyle 一致
- 按大纲场景逐个展开，每场景的 action 要有视觉细节（光线、服装、环境物），可被 AI 绘图直接使用
- 台词口语化、短句为主，适合 TTS 朗读；每个场景 0-4 句台词，纯动作场景可为空数组
- 台词规则：单句 ≤30 字、避免生僻字/长定语/引号内套引号，多用口语词（哦/呀/哼/罢了）；标点以。？！为主
- action 遵循「光线 + 人物动作 + 环境细节 + 景别建议」结构，供分镜 Agent 直接切镜头
- 场景情绪与 action 匹配：紧张场景给急促动作，温情场景给细腻动作（眼神/手部细节）
- 集尾场景必须落到 hookEnd 悬念上

## 参考原文
{perChapterText}`;

const STORYBOARD_DEFAULT = `请为剧本中的一个场景切分镜头（场景 {index}/{total}），只输出 JSON。

## 场景信息
地点：{sceneLocation}｜时间：{sceneTime}
在场角色：{sceneChars}
画面动作：{sceneAction}
{sceneDialogs}

## 角色外观参考
{charLines}

## 输出要求
输出 {"shots": [...]}，每个镜头包含：
- sceneName: 场景名
- camera: { angle: 平视|俯视|仰视|斜角, movement: 固定|推近|拉远|横移|跟随|环绕, shotSize: 特写|近景|中景|全景|远景 }
- action: 该镜头的画面动作描述（≤60字，包含人物动作与情绪细节）
- dialog: 该镜头台词（若台词切分到多镜，按语义拆分；无则null）
- dialogChar: 说话角色名（无则null，必须是"在场角色"中的名字）
- dialogEmotion: 台词情绪（无则null）
- duration: 镜头时长秒数（有台词按语速≈4字/秒，无台词3-5秒）
要求：1-3 个镜头，按剧情节奏切分，不要遗漏关键动作与台词；镜头中的角色动作必须与角色卡外观/性别一致（不得出现性别错位的动作描述）。
镜头语言提示：
- 情绪高点（告白/对峙/转折）优先特写或近景，强化面部微表情
- 环境交代用全景/远景，动作推进用中景+推近
- 悬念镜头用固定机位+缓慢推近，制造压迫感
- 每镜 action 要写明角色做什么 + 情绪状态（如：她攥紧衣角，强装镇定）`;

const CHARACTER_DEFAULT = `{name}的角色设计定妆照，{view}
性别：{gender}
外貌特征：发型「{hair}」；服装「{costume}」；面部特征「{facialMarkers}」；体型「{body}」
角色身份：{roleCN}
整体风格：{charStyle}
全局画风：{anchor}
纯色或浅色干净背景，人物完整可见，柔和顶光 + 正面补光，人物五官清晰对称，肢体比例自然
性别特征必须明确：男角色要有清晰的男性面部轮廓与发型、适度肩宽；女角色要有女性化的发型/妆容与线条（若 gender 为 unknown 则按中性处理）
服装材质细节明确（褶皱/纹理/配饰），发型发丝层次清晰
本角色视觉锚点与同剧其他角色保持明显区分（发色/瞳色/服装主色/标志配饰各异），严禁与其他角色撞脸撞装
无文字，无水印，无多余人物，无 logo`;

const SCENE_DEFAULT = `场景空镜：{name}{mood}
{description}
无人物的纯环境镜头，光线与色调契合氛围，电影级构图
纵深层次清晰：前景/中景/背景三层分明，透视准确，材质细节丰富
本场景必须与同剧其他场景在视觉上明显区分：给出独特的时代风格、建筑材质、主色调与标志性景物（地标/植物/陈设），禁止与其他场景共用同一套环境描述
全局画风：{anchor}
无文字，无水印`;

const PROP_DEFAULT = `道具设计图：{name}{desc}
产品展示角度，干净背景，材质细节清晰
给出道具的形态、材质、色彩与使用痕迹（磨损/纹路/光泽），并说明其年代感与用途暗示
本道具必须与同剧其他道具在造型/材质/色彩上明显区分，避免雷同
全局画风：{anchor}
无文字，无水印`;

const MOTION_DEFAULT = `{size}{angle}，{movement}
画面内容：{action}
人物保持自然姿态，轻微呼吸起伏，发丝与衣角随动作自然飘动，眼神灵动
{dialogHint}
动作连贯流畅，物理合理（重力/惯性自然），手指与五官不变形
镜头运动舒缓克制，电影质感，光影连续稳定，画面清晰锐利
不要大幅动作，不要表情突变，不要文字或水印，不要画面闪烁或跳变`;export const PROMPT_TEMPLATES: PromptTemplateDef[] = [
  {
    key: "extract",
    name: "角色提炼与世界观",
    desc: "Agent 1：从小说提炼角色卡 / 世界观 / 梗概，输出结构化 JSON 供后续流程复用",
    variables: [
      { name: "jsonSchema", desc: "输出 JSON 结构约束（自动注入）" },
      { name: "novelDigest", desc: "小说章节摘要" },
      { name: "fullText", desc: "小说全文（截断 12000 字）" },
    ],
    defaultTemplate: EXTRACT_DEFAULT,
  },
  {
    key: "outline",
    name: "分集大纲",
    desc: "Agent 2：基于角色卡规划整部分集大纲（情绪曲线 / 高情绪点 / 可出图时间光线词）",
    variables: [
      { name: "jsonSchema", desc: "输出 JSON 结构约束（自动注入）" },
      { name: "logline", desc: "一句话梗概" },
      { name: "worldView", desc: "世界观" },
      { name: "characters", desc: "主要角色（名+角色功能）" },
      { name: "episodeCount", desc: "目标集数" },
      { name: "novelDigest", desc: "小说章节摘要" },
    ],
    defaultTemplate: OUTLINE_DEFAULT,
  },
  {
    key: "script",
    name: "单集分镜剧本",
    desc: "Agent 3：把单集大纲扩展为可直接分镜/出图/配音的完整剧本（TTS 友好对白 + 光线动作环境景别结构）",
    variables: [
      { name: "jsonSchema", desc: "输出 JSON 结构约束（自动注入）" },
      { name: "number", desc: "集数" },
      { name: "charDesc", desc: "角色卡（外貌+性格）" },
      { name: "outlineJson", desc: "本集大纲" },
      { name: "perChapterText", desc: "对应章节原文（截断 6000 字）" },
    ],
    defaultTemplate: SCRIPT_DEFAULT,
  },
  {
    key: "storyboard",
    name: "分镜切分",
    desc: "M3：把单场景切分为 1-3 个镜头（景别/运镜/情绪镜头语言）",
    variables: [
      { name: "index", desc: "场景序号" },
      { name: "total", desc: "场景总数" },
      { name: "sceneLocation", desc: "场景地点" },
      { name: "sceneTime", desc: "场景时间/氛围" },
      { name: "sceneChars", desc: "在场角色" },
      { name: "sceneAction", desc: "画面动作描述" },
      { name: "sceneDialogs", desc: "台词行（含角色与情绪）" },
      { name: "charLines", desc: "角色外观参考" },
    ],
    defaultTemplate: STORYBOARD_DEFAULT,
  },
  {
    key: "character",
    name: "角色定妆照",
    desc: "M2：角色设计图提示词（一致性视觉锚点，锁定后作为分镜参考图）",
    variables: [
      { name: "name", desc: "角色名" },
      { name: "view", desc: "视角（正面/四分之三侧面/全身）" },
      { name: "gender", desc: "性别（男性/女性/未知，与角色卡一致）" },
      { name: "hair", desc: "发型发色" },
      { name: "costume", desc: "服装" },
      { name: "facialMarkers", desc: "面部特征" },
      { name: "body", desc: "体型" },
      { name: "roleCN", desc: "角色身份（主角/反派/配角/功能性）" },
      { name: "charStyle", desc: "角色整体风格" },
      { name: "anchor", desc: "全局画风锚点" },
    ],
    defaultTemplate: CHARACTER_DEFAULT,
  },
  {
    key: "scene",
    name: "场景空镜",
    desc: "M2：场景环境图提示词（无人纯环境 + 三层纵深 + 氛围基调）",
    variables: [
      { name: "name", desc: "场景名" },
      { name: "mood", desc: "氛围基调（可空）" },
      { name: "description", desc: "画面描述（可空）" },
      { name: "anchor", desc: "全局画风锚点" },
    ],
    defaultTemplate: SCENE_DEFAULT,
  },
  {
    key: "prop",
    name: "道具设计图",
    desc: "M2：道具/关键物件设计图提示词",
    variables: [
      { name: "name", desc: "道具名" },
      { name: "desc", desc: "道具描述（可空）" },
      { name: "anchor", desc: "全局画风锚点" },
    ],
    defaultTemplate: PROP_DEFAULT,
  },
  {
    key: "motion",
    name: "视频微动态",
    desc: "M4：图生视频微动态提示词（轻微运动 / 呼吸感 / 口型配合）",
    variables: [
      { name: "size", desc: "景别（特写/近景/中景/远景/大全景）" },
      { name: "angle", desc: "视角（平视/俯拍/仰拍…）" },
      { name: "movement", desc: "运镜描述（推近/拉远/横摇…）" },
      { name: "action", desc: "画面内容（镜头动作）" },
      { name: "dialogHint", desc: "台词口型提示（无台词为空）" },
    ],
    defaultTemplate: MOTION_DEFAULT,
  },
];

/** key → 定义索引 */
export const PROMPT_TEMPLATE_MAP: Record<PromptKey, PromptTemplateDef> = Object.fromEntries(
  PROMPT_TEMPLATES.map((t) => [t.key, t])
) as Record<PromptKey, PromptTemplateDef>;

/** 模板定义是否存在 */
export function isPromptKey(k: string): k is PromptKey {
  return Object.hasOwn(PROMPT_TEMPLATE_MAP, k);
}

// ========== 渲染引擎 ==========

/** 模板占位符替换：{var} → 值；未提供的变量保留原样（便于发现缺失） */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined ? m : v;
  });
}

/** 读取某模板的生效文本（项目覆盖 > 全局 > 内置默认），禁用即跳过 */
export async function getPromptTemplate(
  key: PromptKey,
  projectId?: string | null
): Promise<string> {
  const def = PROMPT_TEMPLATE_MAP[key];
  if (!def) return "";

  // 1) 项目级覆盖（仅该小说）
  if (projectId) {
    const projectRow = await prisma.promptTemplate.findFirst({
      where: { key, scope: "project", projectId, enabled: true },
    });
    if (projectRow) return projectRow.template;
  }

  // 2) 全局模板（覆盖所有小说）
  const globalRow = await prisma.promptTemplate.findFirst({
    where: { key, scope: "global", enabled: true },
  });
  if (globalRow) return globalRow.template;

  // 3) 内置默认
  return def.defaultTemplate;
}

/**
 * 读取并渲染模板（自动按优先级解析 + 占位符替换）。
 * 用法：const prompt = await renderPrompt("character", { name, view, ... }, projectId);
 */
export async function renderPrompt(
  key: PromptKey,
  vars: Record<string, string>,
  projectId?: string | null
): Promise<string> {
  const template = await getPromptTemplate(key, projectId);
  return renderTemplate(template, vars);
}

/** 列出某作用域下全部模板行（global 或某 project），无行记录时补默认值 */
export async function listPromptTemplates(projectId?: string | null): Promise<
  (PromptTemplateDef & { global?: PromptTemplateRow; project?: PromptTemplateRow })[]
> {
  const globalRows = (await prisma.promptTemplate.findMany({
    where: { scope: "global" },
  })) as unknown as PromptTemplateRow[];
  const projectRows = projectId
    ? ((await prisma.promptTemplate.findMany({
        where: { scope: "project", projectId },
      })) as unknown as PromptTemplateRow[])
    : [];
  return PROMPT_TEMPLATES.map((def) => {
    const row = (rows: PromptTemplateRow[]) => rows.find((r) => r.key === def.key);
    return {
      ...def,
      global: row(globalRows),
      project: row(projectRows),
    };
  });
}

/** 保存/更新一条模板（findFirst + create/update：key+scope+projectId 唯一） */
export async function upsertPromptTemplate(
  key: PromptKey,
  scope: "global" | "project",
  template: string,
  opts: { projectId?: string | null; name?: string; enabled?: boolean } = {}
): Promise<PromptTemplateRow> {
  const def = PROMPT_TEMPLATE_MAP[key];
  const projectId = opts.projectId ?? null;
  const existing = await prisma.promptTemplate.findFirst({
    where: { key, scope, projectId },
  });
  const data = {
    name: opts.name ?? def.name,
    template,
    enabled: opts.enabled ?? true,
  };
  if (existing) {
    await prisma.promptTemplate.update({ where: { id: existing.id }, data });
  } else {
    await prisma.promptTemplate.create({
      data: { key, scope, projectId, ...data },
    });
  }
  return { key, scope, projectId, ...data };
}

/** 删除一条模板（恢复为下一优先级） */
export async function deletePromptTemplate(
  key: PromptKey,
  scope: "global" | "project",
  projectId?: string | null
): Promise<void> {
  await prisma.promptTemplate.deleteMany({
    where: { key, scope, projectId: projectId ?? null },
  });
}
