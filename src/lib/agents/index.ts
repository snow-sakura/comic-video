/**
 * 剧本工坊 三 Agent 流水线
 * 每个 Agent = LLM 结构化输出（优先） + 启发式回退（Mock/失败时保证有产出）。
 * 由 script 队列的 worker 调用，输入/输出均落库：
 *   Agent1 extractCharacters → Character 表
 *   Agent2 generateOutline   → Script 行（logline + 大纲骨架）
 *   Agent3 generateEpisode   → Script.content.episodes[i] + Episode 行
 */
import { prisma } from "@/lib/db";
import { getScriptLLM } from "@/lib/providers/registry";
import type { LLMMessage } from "@/lib/providers/types";
import { parseNovel, chapterText, chaptersDigest, heuristicCharacters, type NovelMeta } from "@/lib/novel/parser";
import { safeParseJson, asString, asStringArray, asRecord } from "@/lib/agents/json";
import {
  buildExtractPrompt,
  buildOutlinePrompt,
  buildEpisodeScriptPrompt,
  type OutlineEpisode,
  type EpisodeScript,
} from "@/lib/agents/prompts";

export type ScriptStage = "characters" | "outline" | "script";

const EPISODE_COUNT = 6; // 默认集数（可在设置扩展）

// ========== 工具 ==========

async function llmJson(messages: LLMMessage[]): Promise<unknown | null> {
  try {
    const llm = await getScriptLLM();
    const raw = await llm.chat(messages, { json: true, temperature: 0.6, maxTokens: 8192 });
    return safeParseJson(raw);
  } catch {
    return null;
  }
}

async function getNovel(projectId: string): Promise<{ text: string; meta: NovelMeta }> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("项目不存在");
  if (!project.novelText) throw new Error("尚未上传小说，请先在剧本工坊上传小说文本");
  const meta = (project.novelMeta ?? { chapters: [{ index: 1, title: "全文", start: 0, end: project.novelText.length }] }) as NovelMeta;
  return { text: project.novelText, meta };
}

async function setStage(projectId: string, stage: ScriptStage): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: { novelMeta: { ...(await getNovel(projectId)).meta, stage } as never },
  }).catch(() => {});
}

function validRole(role: string): "protagonist" | "supporting" | "antagonist" | "utility" {
  return ["protagonist", "supporting", "antagonist", "utility"].includes(role)
    ? (role as never)
    : "supporting";
}

// ========== Agent 1：角色提炼 ==========

export async function runExtractCharacters(projectId: string): Promise<{ count: number; logline?: string }> {
  const { text, meta } = await getNovel(projectId);
  const digest = chaptersDigest(meta, text);
  const parsed = await llmJson([
    { role: "system", content: "你是漫剧编剧统筹，只输出 JSON。" },
    { role: "user", content: buildExtractPrompt(digest, text) },
  ]);

  let logline: string | undefined;
  let worldView: string | undefined;
  let chars: { name: string; role: string; appearance: Record<string, string>; personality: Record<string, string>; voiceName?: string }[] = [];

  if (parsed && asRecord(parsed).characters && Array.isArray(asRecord(parsed).characters)) {
    const rec = asRecord(parsed);
    logline = asString(rec.logline) || undefined;
    worldView = asString(rec.worldView) || undefined;
    chars = (rec.characters as unknown[])
      .map((c) => {
        const r = asRecord(c);
        const appearance = asRecord(r.appearance);
        const personality = asRecord(r.personality);
        return {
          name: asString(r.name),
          role: validRole(asString(r.role)),
          appearance: {
            hair: asString(appearance.hair, "待定"),
            costume: asString(appearance.costume, "待定"),
            facialMarkers: asString(appearance.facialMarkers, "待定"),
            body: asString(appearance.body, "待定"),
            style: asString(appearance.style, "待定"),
          },
          personality: {
            habits: asString(personality.habits, "待定"),
            emotionalReactions: asString(personality.emotionalReactions, "待定"),
            speechStyle: asString(personality.speechStyle, "待定"),
            psychology: asString(personality.psychology, "待定"),
          },
          voiceName: asString(r.voiceName) || undefined,
        };
      })
      .filter((c) => c.name);
  } else {
    // 回退：启发式提取
    chars = heuristicCharacters(text).map((c) => ({
      name: c.name,
      role: c.role,
      appearance: c.appearance as never,
      personality: c.personality as never,
      voiceName: undefined,
    }));
    logline = undefined;
    worldView = undefined;
  }

  // 落库：清空旧角色后写入
  await prisma.character.deleteMany({ where: { projectId } });
  if (chars.length > 0) {
    await prisma.character.createMany({
      data: chars.map((c) => ({
        projectId,
        name: c.name,
        role: c.role,
        appearance: c.appearance as never,
        personality: c.personality as never,
        voiceName: c.voiceName,
        status: "DRAFTING",
      })),
    });
  }
  // 角色卡写进 Script 供后续 Agent 复用
  await prisma.script.upsert({
    where: { id: await scriptId(projectId) },
    create: {
      projectId,
      logline: logline ?? null,
      content: { worldView, characters: chars } as never,
      status: "draft",
    },
    update: { logline: logline ?? undefined, content: { worldView, characters: chars } as never },
  });
  await setStage(projectId, "characters");
  return { count: chars.length, logline };
}

/** 项目当前 Script 行 id（没有则创建空行） */
async function scriptId(projectId: string): Promise<string> {
  const existing = await prisma.script.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (existing) return existing.id;
  const created = await prisma.script.create({ data: { projectId } });
  return created.id;
}

// ========== Agent 2：分集大纲 ==========

export async function runGenerateOutline(projectId: string): Promise<{ episodes: number; logline?: string }> {
  const { text, meta } = await getNovel(projectId);
  const digest = chaptersDigest(meta, text);
  const script = await prisma.script.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  const characters = await prisma.character.findMany({ where: { projectId } });
  if (characters.length === 0) throw new Error("请先提炼角色");

  const parsed = await llmJson([
    { role: "system", content: "你是漫剧总编剧，只输出 JSON。" },
    {
      role: "user",
      content: buildOutlinePrompt(
        digest,
        asString(asRecord(script?.content).logline, ""),
        asString(asRecord(script?.content).worldView, ""),
        characters.map((c) => ({ name: c.name, role: c.role })),
        EPISODE_COUNT
      ),
    },
  ]);

  let logline = asString(asRecord(script?.content).logline) || asString(asRecord(parsed).logline) || undefined;
  let episodes: OutlineEpisode[] = [];
  if (parsed && Array.isArray(asRecord(parsed).episodes)) {
    episodes = (asRecord(parsed).episodes as unknown[]).map((e, i) => {
      const r = asRecord(e);
      const scenes = Array.isArray(r.scenes)
        ? (r.scenes as unknown[]).map((s) => {
            const sr = asRecord(s);
            return {
              location: asString(sr.location, "未知场景"),
              time: asString(sr.time, "日"),
              summary: asString(sr.summary, ""),
            };
          })
        : [{ location: "主线场景", time: "日", summary: "" }];
      return {
        number: Number(asString(r.number, String(i + 1))) || i + 1,
        title: asString(r.title, `第${i + 1}集`),
        hookEnd: asString(r.hookEnd, "悬念待定"),
        summary: asString(r.summary, ""),
        scenes,
      };
    });
  } else {
    // 回退：按章节生成基础大纲
    const count = Math.min(EPISODE_COUNT, meta.chapters.length || EPISODE_COUNT);
    episodes = Array.from({ length: count }, (_, i) => {
      const ch = meta.chapters[Math.min(i, meta.chapters.length - 1)];
      const chBody = ch ? chapterText(meta, text, ch.index).replace(/\s+/g, " ").slice(0, 120) : "";
      return {
        number: i + 1,
        title: ch?.title || `第${i + 1}集`,
        hookEnd: `第${i + 1}集结尾埋下反转钩子`,
        summary: chBody ? `围绕「${ch.title}」展开：${chBody}…` : `第${i + 1}集剧情推进`,
        scenes: [{ location: "主线场景", time: "日", summary: chBody || "剧情推进" }],
      };
    });
    logline = logline ?? `《${(await prisma.project.findUnique({ where: { id: projectId } }))?.title ?? "未命名"}》的漫剧改编`;
  }

  // 落库：更新 Script（保留角色卡）
  const sid = await scriptId(projectId);
  const existing = await prisma.script.findUnique({ where: { id: sid } });
  const prevContent = asRecord(existing?.content);
  await prisma.script.update({
    where: { id: sid },
    data: {
      logline: logline ?? null,
      content: {
        ...prevContent,
        worldView: prevContent.worldView ?? undefined,
        episodes: episodes.map((e) => ({ ...e, scenes: undefined })),
        episodeOutlines: episodes,
      } as never,
    },
  });
  // 创建 Episode 骨架行
  for (const ep of episodes) {
    await prisma.episode.upsert({
      where: { projectId_number: { projectId, number: ep.number } },
      create: { projectId, number: ep.number, title: ep.title, hookEnd: ep.hookEnd, status: "draft" },
      update: { title: ep.title, hookEnd: ep.hookEnd },
    });
  }
  await setStage(projectId, "outline");
  return { episodes: episodes.length, logline };
}

// ========== Agent 3：单集分镜剧本 ==========

export async function runGenerateEpisode(projectId: string, episodeNumber: number): Promise<EpisodeScript> {
  const { text, meta } = await getNovel(projectId);
  const script = await prisma.script.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!script) throw new Error("请先生成大纲");
  const content = asRecord(script.content);
  const outlines = (content.episodeOutlines as unknown) ?? [];
  const outline = Array.isArray(outlines) ? (outlines as OutlineEpisode[]).find((o) => o.number === episodeNumber) : undefined;
  if (!outline) throw new Error(`第${episodeNumber}集大纲不存在，请先生成大纲`);
  const characters = await prisma.character.findMany({ where: { projectId } });

  const perChapter = meta.chapters.length >= episodeNumber ? chapterText(meta, text, episodeNumber) : text;
  const parsed = await llmJson([
    { role: "system", content: "你是漫剧分集编剧，只输出 JSON。" },
    {
      role: "user",
      content: buildEpisodeScriptPrompt(
        chaptersDigest(meta, text, 400),
        characters.map((c) => ({ name: c.name, role: c.role, appearance: c.appearance as never, personality: c.personality as never })),
        outline,
        perChapter
      ),
    },
  ]);

  let ep: EpisodeScript;
  if (parsed && Array.isArray(asRecord(parsed).scenes)) {
    const r = asRecord(parsed);
    ep = {
      number: Number(asString(r.number, String(episodeNumber))) || episodeNumber,
      title: asString(r.title, outline.title),
      hookEnd: asString(r.hookEnd, outline.hookEnd),
      scenes: (r.scenes as unknown[]).map((s) => {
        const sr = asRecord(s);
        return {
          location: asString(sr.location, "主线场景"),
          time: asString(sr.time, "日"),
          characters: asStringArray(sr.characters),
          action: asString(sr.action, ""),
          dialogs: Array.isArray(sr.dialogs)
            ? (sr.dialogs as unknown[]).map((d) => {
                const dr = asRecord(d);
                return { char: asString(dr.char), text: asString(dr.text), emotion: asString(dr.emotion, "平静") };
              })
            : [],
        };
      }),
    };
  } else {
    // 回退：用大纲场景生成基础剧本
    ep = {
      number: episodeNumber,
      title: outline.title,
      hookEnd: outline.hookEnd,
      scenes: outline.scenes.map((s) => ({
        location: s.location,
        time: s.time,
        characters: characters.slice(0, 3).map((c) => c.name),
        action: `${s.summary}（本场景为启发式生成，配置 LLM Key 后重新生成可获高质量剧本）`,
        dialogs: characters.slice(0, 1).map((c) => ({ char: c.name, text: `${s.summary}`, emotion: "平静" })),
      })),
    };
  }

  // 落库：更新 Script.content.episodes[number-1]
  const sid = await scriptId(projectId);
  const existing = await prisma.script.findUnique({ where: { id: sid } });
  const prev = asRecord(existing?.content);
  const episodes = Array.isArray(prev.episodes) ? (prev.episodes as unknown[]) : [];
  episodes[ep.number - 1] = ep;
  await prisma.script.update({
    where: { id: sid },
    data: { content: { ...prev, episodes } as never },
  });
  await prisma.episode.upsert({
    where: { projectId_number: { projectId, number: ep.number } },
    create: { projectId, number: ep.number, title: ep.title, hookEnd: ep.hookEnd, status: "draft" },
    update: { title: ep.title, hookEnd: ep.hookEnd },
  });
  await setStage(projectId, "script");
  return ep;
}

/** 获取剧本工坊当前阶段（供 UI 判断可执行步骤） */
export async function getScriptStage(projectId: string): Promise<ScriptStage | "none"> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const meta = asRecord(project?.novelMeta);
  const stage = asString(meta.stage) as ScriptStage;
  if (!["characters", "outline", "script"].includes(stage)) {
    return project?.novelText ? "characters" : "none";
  }
  return stage;
}
