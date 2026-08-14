/**
 * 项目卡片状态推断的纯函数与类型（Web 端与移动端共享）
 *
 * 从项目数据推断 4 大步骤 × 子步骤状态、顶层执行状态。
 * 不含任何 React / 副作用，可在两端组件中直接复用。
 */

export interface Project {
  id: string;
  title: string;
  /** Prisma ProjectStatus */
  status: string;
  episodeCount: number;
  createdAt: string;
  updatedAt: string;
  novelText?: string | null;
  novelPath?: string | null;
  _count?: { scripts: number; characters: number; scenes: number; episodes: number };
  scripts?: {
    id: string;
    approved: boolean;
    version: number;
    status: string;
    content?: { episodes?: { number?: number; scenes?: unknown[] }[] } | null;
  }[];
  characters?: { id: string; name: string; refImageIds: string[] }[];
  scenes?: { id: string; name: string; refImageIds: string[] }[];
  assets?: { id: string; type: string }[];
  episodes?: { id: string; number: number; status: string; finalPath: string | null; shots?: { status: string }[] }[];
  tasks?: { status: string; type: string }[];
}

export type SubStatus = "done" | "active" | "pending";

export interface SubStep {
  id: string;
  name: string;
  status: SubStatus;
  /** 进度数字（如 6/6），无则 null */
  progress: string | null;
}

export interface FlowStep {
  key: string;
  num: string;
  name: string;
  desc: string;
  status: SubStatus;
  subs: SubStep[];
}

/** 默认目标集数，与创建项目默认值一致 */
export const STEP_TARGET = 6;

/**
 * 统计剧本中「已生成完整分集剧本」的集数（带 scenes 的 episode 条目）。
 * Script 行的 approved 字段全代码库无写入入口，完成态只能从内容推断。
 */
function countGeneratedEpisodes(content: Project["scripts"] extends (infer S)[] | undefined ? S : never): number {
  const c = content?.content;
  const episodes = Array.isArray(c?.episodes) ? c.episodes : [];
  return episodes.filter((e) => e && Array.isArray(e.scenes) && e.scenes.length > 0).length;
}

/**
 * 镜头尚未产出画面的状态（其余状态视为已有结果：IMAGE_DONE/FAILED、VIDEO_*、VOICE_*、COMPOSED 等）。
 * 用排除法判断，未来新增状态自动兼容。
 */
const SHOT_IMAGE_PENDING = new Set(["PENDING", "PROMPT_READY", "IMAGE_GENERATING", "VIDEO_GENERATING", "VOICE_GENERATING"]);

/** 该集分镜·出图是否完成（有镜头且无任何未出图/生成中的镜头） */
function isEpisodeStoryboarded(ep: Project["episodes"] extends (infer E)[] | undefined ? E : never): boolean {
  const shots = ep.shots ?? [];
  return shots.length > 0 && shots.every((s) => !SHOT_IMAGE_PENDING.has(s.status));
}

/** 根据项目实际数据推断 4 大步骤 × 各子步骤状态 */
export function inferSteps(p: Project): FlowStep[] {
  const hasNovel = Boolean(p.novelText?.trim() || p.novelPath);
  const characters = p.characters ?? [];
  const scenes = p.scenes ?? [];
  const assets = p.assets ?? [];
  const episodes = p.episodes ?? [];
  const scripts = p.scripts ?? [];

  const charsWithImage = characters.filter((c) => c.refImageIds?.length > 0).length;
  const scenesWithImage = scenes.filter((s) => s.refImageIds?.length > 0).length;
  const propsWithImage = assets.length;
  const episodesComposed = episodes.filter((e) => e.finalPath).length;
  const storyboardedEpisodes = episodes.filter((e) => isEpisodeStoryboarded(e)).length;
  const totalEpisodes = episodes.length;
  const scriptGeneratedCount = Math.max(0, ...scripts.map((s) => countGeneratedEpisodes(s)));

  // ---- 01 剧本工坊 ----
  const s1_1_done = hasNovel;
  const s1_2_done = characters.length > 0;
  const s1_3_done = episodes.length >= (p.episodeCount || STEP_TARGET) && episodes.length > 0;
  const s1_4_done = scriptGeneratedCount >= (p.episodeCount || STEP_TARGET);
  const s1_active = s1_1_done
    ? s1_2_done
      ? s1_3_done
        ? s1_4_done
          ? "done"
          : "active"
        : "active"
      : "active"
    : "active";

  const s1: FlowStep = {
    key: "script",
    num: "01",
    name: "剧本工坊",
    desc: "上传小说 → 提炼人设 → 生成分集剧本",
    status: s1_active as SubStatus,
    subs: [
      { id: "script-upload", name: "上传小说", status: s1_1_done ? "done" : hasNovel ? "active" : "pending", progress: null },
      { id: "script-character", name: "提炼角色", status: s1_2_done ? "done" : characters.length > 0 ? "active" : "pending", progress: characters.length > 0 ? `${characters.length}` : null },
      { id: "script-outline", name: "分集大纲", status: s1_3_done ? "done" : episodes.length > 0 ? "active" : "pending", progress: episodes.length > 0 ? `${episodes.length}/${p.episodeCount || STEP_TARGET}` : null },
      { id: "script-scripts", name: "分集剧本", status: s1_4_done ? "done" : scripts.length > 0 ? "active" : "pending", progress: scripts.length > 0 ? `${scripts.length}` : null },
    ],
  };

  // ---- 02 资产工厂 ----
  const s2_chars_done = charsWithImage >= characters.length && characters.length > 0;
  const s2_scenes_done = scenesWithImage >= scenes.length && scenes.length > 0;
  const s2_props_done = propsWithImage > 0;
  const s2_complete = s2_chars_done && s2_scenes_done && s2_props_done;
  const s2_start = s1.subs.every((s) => s.status === "done");
  const s2_status: SubStatus = s2_complete ? "done" : s2_start ? "active" : "pending";

  const s2: FlowStep = {
    key: "asset",
    num: "02",
    name: "资产工厂",
    desc: "角色 / 场景 / 道具设计稿 + 一致性锁定",
    status: s2_status,
    subs: [
      { id: "asset-character", name: "角色定妆照", status: s2_chars_done ? "done" : charsWithImage > 0 || characters.length > 0 ? "active" : "pending", progress: characters.length > 0 ? `${charsWithImage}/${characters.length}` : null },
      { id: "asset-scene", name: "场景空镜", status: s2_scenes_done ? "done" : scenesWithImage > 0 || scenes.length > 0 ? "active" : "pending", progress: scenes.length > 0 ? `${scenesWithImage}/${scenes.length}` : null },
      { id: "asset-prop", name: "道具设计", status: s2_props_done ? "done" : "pending", progress: assets.length > 0 ? `${assets.length}` : null },
    ],
  };

  // ---- 03 分镜车间 ----
  // 分镜完成 = 全部剧集已生成分镜图（与成片数无关；成片属于第 04 步）
  const s3_start = s2.status === "done";
  const s3_active = totalEpisodes > 0;
  const s3_complete = totalEpisodes > 0 && storyboardedEpisodes >= totalEpisodes;
  const s3_status: SubStatus = s3_complete ? "done" : s3_start ? "active" : "pending";

  const s3: FlowStep = {
    key: "storyboard",
    num: "03",
    name: "分镜车间",
    desc: "AI 分镜 → 7 维提示词 → 批量出图",
    status: s3_status,
    subs: [
      { id: "storyboard-episode", name: "选择剧集", status: s3_active ? "done" : s3_start ? "active" : "pending", progress: totalEpisodes > 0 ? `${totalEpisodes}集` : null },
      { id: "storyboard-shots", name: "分镜 · 出图", status: s3_complete ? "done" : s3_active ? "active" : "pending", progress: s3_active ? `${storyboardedEpisodes}/${totalEpisodes}` : null },
    ],
  };

  // ---- 04 视频合成厂 ----
  const s4_start = s3.status === "done";
  const s4_status: SubStatus =
    s4_start && episodesComposed >= totalEpisodes && totalEpisodes > 0 ? "done" : s4_start ? "active" : "pending";

  const s4: FlowStep = {
    key: "compose",
    num: "04",
    name: "视频合成厂",
    desc: "微动态 / TTS 配音 / 音效 BGM / 合成导出",
    status: s4_status,
    subs: [
      { id: "compose-episode", name: "选择剧集", status: s4_start ? "done" : "pending", progress: null },
      { id: "compose-preview", name: "成片预览", status: episodesComposed > 0 ? "done" : s4_start ? "active" : "pending", progress: episodesComposed > 0 ? `${episodesComposed}/${totalEpisodes}` : null },
      { id: "compose-shots", name: "镜头 · 配音", status: s4_status === "done" ? "done" : episodesComposed > 0 ? "active" : "pending", progress: null },
    ],
  };

  return [s1, s2, s3, s4];
}

// ========== 顶层执行状态 ==========

export type ExecState = "IDLE" | "RUNNING" | "PAUSED" | "FAILED";

export const EXEC_LABEL: Record<ExecState, string> = {
  IDLE: "空闲",
  RUNNING: "执行中",
  PAUSED: "暂停",
  FAILED: "失败",
};

export const EXEC_COLOR: Record<ExecState, string> = {
  IDLE: "bg-zinc-700/40 text-zinc-400",
  RUNNING: "bg-emerald-500/15 text-emerald-300",
  PAUSED: "bg-amber-500/15 text-amber-300",
  FAILED: "bg-red-500/15 text-red-300",
};

export const EXEC_DOT: Record<ExecState, string> = {
  IDLE: "bg-zinc-600",
  RUNNING: "bg-emerald-400 animate-pulse",
  PAUSED: "bg-amber-400",
  FAILED: "bg-red-400",
};

export function inferExecState(p: Project): ExecState {
  const tasks = p.tasks ?? [];
  const hasFailed = tasks.some((t) => t.status === "FAILED");
  if (hasFailed) return "FAILED";
  const hasPaused = tasks.some((t) => t.status === "PAUSED");
  if (hasPaused) return "PAUSED";
  const hasActive = tasks.some((t) => t.status === "PROCESSING" || t.status === "QUEUED");
  if (hasActive) return "RUNNING";
  return "IDLE";
}
