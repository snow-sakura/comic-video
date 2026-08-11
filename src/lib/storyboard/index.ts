/**
 * 分镜车间 Agent（M3）
 * 流程：剧本单集 → 分镜（场景→镜头切分）→ 7 维提示词组装（引用锁定资产）→ Shot 行落库
 * 出图由 image 队列执行（见 storyboard API 与 workers.imageHandler）。
 */
import { prisma } from "@/lib/db";
import { getScriptLLM } from "@/lib/providers/registry";
import type { LLMMessage } from "@/lib/providers/types";
import { asRecord, asString, asStringArray, safeParseJson } from "@/lib/agents/json";
import { styleAnchor } from "@/lib/assets/prompts";
import {
  buildStoryboardPrompt,
  fallbackShots,
  buildPrompt7,
  assembleFinalPrompt,
  lightingFor,
  type ShotSpec,
  type StoryboardScene,
  type CharacterCard,
} from "@/lib/storyboard/prompts";

// ========== 工具 ==========

async function llmJson(messages: LLMMessage[]): Promise<unknown | null> {
  try {
    const llm = await getScriptLLM();
    const raw = await llm.chat(messages, { json: true, temperature: 0.5, maxTokens: 8192 });
    return safeParseJson(raw);
  } catch {
    return null;
  }
}

/** 读取单集剧本场景 */
async function getEpisodeScenes(projectId: string, episodeNumber: number): Promise<StoryboardScene[]> {
  const script = await prisma.script.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!script) throw new Error("请先在剧本工坊生成剧本");
  const content = asRecord(script.content);
  const episodes = Array.isArray(content.episodes) ? (content.episodes as unknown[]) : [];
  const ep = episodes.find((e) => Number(asRecord(e).number) === episodeNumber) ?? episodes[episodeNumber - 1];
  if (!ep) throw new Error(`第${episodeNumber}集剧本不存在`);
  const scenes = Array.isArray(asRecord(ep).scenes) ? (asRecord(ep).scenes as unknown[]) : [];
  if (scenes.length === 0) throw new Error("该集剧本暂无场景");
  return scenes.map((s) => {
    const r = asRecord(s);
    return {
      location: asString(r.location, "未知场景"),
      time: asString(r.time, "日"),
      characters: asStringArray(r.characters),
      action: asString(r.action, ""),
      dialogs: Array.isArray(r.dialogs)
        ? (r.dialogs as unknown[]).map((d) => {
            const dr = asRecord(d);
            return { char: asString(dr.char), text: asString(dr.text), emotion: asString(dr.emotion, "平静") };
          })
        : [],
    };
  });
}

/** 生成 Shot 行（分镜 Agent） */
export async function runStoryboardEpisode(projectId: string, episodeNumber: number): Promise<{ shots: number }> {
  const episode = await prisma.episode.findUnique({
    where: { projectId_number: { projectId, number: episodeNumber } },
  });
  if (!episode) throw new Error(`第${episodeNumber}集不存在`);
  const scenes = await getEpisodeScenes(projectId, episodeNumber);
  const chars = await prisma.character.findMany({ where: { projectId } });
  const charCards: CharacterCard[] = chars.map((c) => ({
    name: c.name,
    role: c.role,
    appearance: (c.appearance ?? {}) as Record<string, string>,
  }));
  const allShots: ShotSpec[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const parsed = await llmJson([
      { role: "system", content: "你是漫剧分镜师，只输出 JSON。" },
      { role: "user", content: buildStoryboardPrompt(scene, charCards, i, scenes.length) },
    ]);
    const rec = parsed ? asRecord(parsed) : null;
    const list = Array.isArray(rec?.shots)
      ? ((rec.shots as unknown[]).map((s) => {
          const r = asRecord(s);
          const cam = asRecord(r.camera);
          const dur = Number(asString(r.duration, "4"));
          return {
            sceneName: asString(r.sceneName, scene.location),
            camera: {
              angle: asString(cam.angle, "平视"),
              movement: asString(cam.movement, "固定"),
              shotSize: asString(cam.shotSize, "中景"),
            },
            action: asString(r.action, scene.action.slice(0, 60) || "镜头动作"),
            dialog: asString(r.dialog) || null,
            dialogChar: asString(r.dialogChar) || null,
            dialogEmotion: asString(r.dialogEmotion) || null,
            duration: Number.isFinite(dur) && dur > 0 ? dur : 4,
          };
        }) as ShotSpec[])
      : fallbackShots(scene);
    allShots.push(...list);
  }

  // 落库：重建该集全部镜头
  await prisma.shot.deleteMany({ where: { episodeId: episode.id } });
  if (allShots.length > 0) {
    await prisma.shot.createMany({
      data: allShots.map((s, i) => ({
        episodeId: episode.id,
        sequence: i + 1,
        sceneName: s.sceneName,
        sceneId: null,
        camera: s.camera as never,
        action: s.action,
        dialog: s.dialog,
        dialogChar: s.dialogChar,
        dialogEmotion: s.dialogEmotion,
        duration: s.duration,
        status: "PROMPT_READY",
      })),
    });
  }
  await prisma.episode.update({
    where: { id: episode.id },
    data: { status: "storyboard" },
  });

  // 组装 7 维提示词（引用锁定资产）
  await assembleAllShotPrompts(projectId, episode.id);
  return { shots: allShots.length };
}

/** 为某集所有 Shot 组装 finalPrompt + 参考图（重复调用幂等） */
export async function assembleAllShotPrompts(projectId: string, episodeId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const anchor = styleAnchor((project?.style ?? null) as never);
  const [shots, chars, scenes] = await Promise.all([
    prisma.shot.findMany({ where: { episodeId } }),
    prisma.character.findMany({ where: { projectId } }),
    prisma.scene.findMany({ where: { projectId } }),
  ]);
  // 已锁定角色的定妆照（一致性参考）
  const charRefs = new Map<string, string[]>();
  for (const c of chars) {
    if (c.status === "APPROVED" && c.refImageIds.length > 0) {
      charRefs.set(c.name, c.refImageIds);
    }
  }
  // 已锁定场景的空镜
  const sceneRefs = new Map<string, string[]>();
  for (const s of scenes) {
    if (s.status === "APPROVED" && s.refImageIds.length > 0) {
      sceneRefs.set(s.name, s.refImageIds);
    }
  }
  const charAppearance = new Map(chars.map((c) => [c.name, (c.appearance ?? {}) as Record<string, string>]));
  const sceneMood = new Map(scenes.map((s) => [s.name, s.mood]));

  for (const shot of shots) {
    const app = shot.dialogChar ? charAppearance.get(shot.dialogChar) : undefined;
    const subject = shot.dialogChar
      ? [
          `${shot.dialogChar}：`,
          app?.costume ? `身穿${app.costume}` : "",
          app?.hair ? `，${app.hair}` : "",
          app?.facialMarkers ? `，${app.facialMarkers}` : "",
          app?.body ? `，${app.body}` : "",
          shot.dialogEmotion ? `，${shot.dialogEmotion}表情` : "，中性表情",
        ].join("")
      : `画面主体：${(shot.action ?? "").slice(0, 40)}`;
    const p7 = buildPrompt7(
      {
        sceneName: shot.sceneName ?? "",
        camera: (shot.camera ?? {}) as never,
        action: shot.action ?? "",
        dialog: shot.dialog,
        dialogChar: shot.dialogChar,
        dialogEmotion: shot.dialogEmotion,
        duration: shot.duration,
      },
      {
        subject,
        environment: shot.sceneName ?? "",
        lighting: lightingFor(sceneMood.get(shot.sceneName ?? "") ?? null, shot.sceneName),
        styleAnchor: anchor,
      }
    );
    const refImages = [
      ...(shot.dialogChar ? charRefs.get(shot.dialogChar) ?? [] : []),
      ...(shot.sceneName ? sceneRefs.get(shot.sceneName) ?? [] : []),
    ].slice(0, 4);
    await prisma.shot.update({
      where: { id: shot.id },
      data: {
        prompt7: p7 as never,
        finalPrompt: assembleFinalPrompt(p7),
        refImages,
        status: shot.status === "IMAGE_GENERATING" ? shot.status : "PROMPT_READY",
      },
    });
  }
}
