/**
 * POST /api/projects/[id]/assets — 生成资产生成任务
 *   body: { kind: "character" | "scene" | "prop", refId?, regenerate? }
 *   character → image 队列，出图后写回 Character.refImageIds（一致性锁定基础）
 * GET  — 资产聚合列表（角色/场景/道具 + 剧本场景惰性同步）
 * PATCH — { refId, status: "APPROVED"|"REJECTED"|"DRAFTING", kind } 一致性锁定/解锁
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueGenTask } from "@/lib/queue/queues";
import { characterDesignPrompt, sceneDesignPrompt, propDesignPrompt, styleAnchor, inferMood } from "@/lib/assets/prompts";
import { matchVoiceId } from "@/lib/providers/tts";
import type { AssetStatus } from "@/generated/prisma/client";

// ========== 场景惰性同步（从剧本提取） ==========

// 节流：GET 是轮询接口（每 4s 一次），而剧本变化频率极低。
// 同一项目 60s 内只做一次同步，避免只读请求反复查库/写库。
const sceneSyncThrottle = new Map<string, number>();
const SCENE_SYNC_TTL_MS = 60_000;

async function syncScenes(projectId: string): Promise<void> {
  const now = Date.now();
  if (now - (sceneSyncThrottle.get(projectId) ?? 0) < SCENE_SYNC_TTL_MS) return;
  sceneSyncThrottle.set(projectId, now);

  const script = await prisma.script.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!script) return;
  const content = (script.content ?? {}) as { episodes?: { scenes?: { location?: string; time?: string; action?: string }[] }[] };
  const seen = new Set<string>();
  const sceneInputs: { name: string; description: string | null; mood: string | null }[] = [];
  for (const ep of content.episodes ?? []) {
    for (const s of ep.scenes ?? []) {
      const name = (s.location ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      sceneInputs.push({
        name,
        description: s.action ? s.action.slice(0, 200) : null,
        mood: inferMood(`${s.time ?? ""} ${s.action ?? ""}`),
      });
    }
  }
  const existing = await prisma.scene.findMany({ where: { projectId }, select: { name: true } });
  const existNames = new Set(existing.map((e) => e.name));
  const toCreate = sceneInputs.filter((s) => !existNames.has(s.name));
  if (toCreate.length > 0) {
    await prisma.scene.createMany({
      data: toCreate.map((s) => ({ projectId, ...s, status: "DRAFTING" })),
    });
  }
}

// ========== POST 生成 ==========

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const kind = body?.kind as string | undefined;
    const refId = body?.refId ? String(body.refId) : undefined;
    const regenerate = body?.regenerate === true;

    if (!["character", "scene", "prop", "voice"].includes(kind ?? "")) {
      return NextResponse.json({ error: "kind 必须是 character | scene | prop | voice" }, { status: 400 });
    }

    // ========== 音色智能化：角色描述 → 匹配最接近音色 ==========
    // 规则：优先角色提炼时 LLM 输出的 voiceId 枚举；否则按 voiceName 描述关键词匹配，
    // 性别兜底（描述含"男/女"推断），最后默认柔美女声。匹配结果写回 Character.voiceId。
    if (kind === "voice") {
      const characters = refId
        ? [await prisma.character.findFirst({ where: { id: refId, projectId: id } })]
        : await prisma.character.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } });
      const targets = characters.filter((c): c is NonNullable<typeof c> => !!c);
      if (targets.length === 0) return NextResponse.json({ error: "暂无角色" }, { status: 404 });

      const updated: { id: string; name: string; voiceId: string; voiceName: string | null }[] = [];
      for (const c of targets) {
        // 性别优先用角色卡 gender 字段（提炼阶段推断），旧角色无 gender 时回退文本推断
        const gender = (c.gender as string | null) ?? ((c.voiceName ?? "").includes("男") ? "male" : (c.voiceName ?? "").includes("女") ? "female" : undefined);
        const voiceId = matchVoiceId(c.voiceName ?? undefined, gender ?? undefined);
        await prisma.character.update({ where: { id: c.id }, data: { voiceId } });
        updated.push({ id: c.id, name: c.name, voiceId, voiceName: c.voiceName });
      }
      return NextResponse.json({ ok: true, updated, kind: "voice" });
    }

    // 运行中任务保护
    const running = await prisma.genTask.findFirst({
      where: { projectId: id, type: "IMAGE", status: { in: ["QUEUED", "PROCESSING"] } },
    });
    if (running) {
      return NextResponse.json({ error: "已有图像任务进行中", runningTaskId: running.id }, { status: 409 });
    }

    const anchor = styleAnchor(project.style as never);

    // ========== 角色定妆照：支持批量 + 三角度独立任务 ==========
    // 无 refId → 全部待生成角色；每个角色 3 个独立任务（正面/四分之三侧面/全身），
    // 每个角度独立 prompt（避免一次 count=3 时模型忽略"另附两张"导致缺全身/侧面像）
    if (kind === "character") {
      const characters = refId
        ? [await prisma.character.findFirst({ where: { id: refId, projectId: id } })]
        : await prisma.character.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } });
      const targets = characters.filter((c): c is NonNullable<typeof c> => !!c);
      if (targets.length === 0) return NextResponse.json({ error: "角色不存在" }, { status: 404 });

      const enqueued: { characterId: string; taskId: string; angle: string }[] = [];
      for (const character of targets) {
        const c = character.appearance as never as { hair?: string; costume?: string; facialMarkers?: string; body?: string; style?: string };
        const input = {
          name: character.name,
          role: character.role,
          gender: character.gender,
          appearance: {
            hair: c.hair ?? "待定",
            costume: c.costume ?? "待定",
            facialMarkers: c.facialMarkers ?? "待定",
            body: c.body ?? "待定",
            style: c.style ?? "待定",
          },
          refImageIds: character.refImageIds,
        };
        // 已锁定定妆照 → 只补一张四分之三侧面（用已锁定图做参考）
        const locked = !regenerate && character.refImageIds.length > 0 && character.status === "APPROVED";
        const angles = locked
          ? [{ angle: "three-quarter" as const, label: "侧面补全" }]
          : [
              { angle: "front" as const, label: "正面" },
              { angle: "three-quarter" as const, label: "侧面" },
              { angle: "full" as const, label: "全身" },
            ];
        for (const { angle, label: angleLabel } of angles) {
          const prompt = await characterDesignPrompt(input, anchor, angle, id);
          const task = await prisma.genTask.create({
            data: {
              projectId: id,
              label: `角色定妆照·${character.name}·${angleLabel}`,
              type: "IMAGE",
              provider: "seedream",
              model: "seedream-5-0",
              refType: "character",
              refId: character.id,
              status: "QUEUED",
              input: { kind, angle, prompt: prompt.slice(0, 500), refImages: character.refImageIds.length } as never,
            },
          });
          await enqueueGenTask("image", {
            taskId: task.id,
            payload: {
              prompt,
              refImages: locked ? character.refImageIds : [],
              count: 1,
              aspectRatio: "3:4",
              refType: "character",
              refId: character.id,
              category: "characters",
            },
          });
          enqueued.push({ characterId: character.id, taskId: task.id, angle });
        }
      }
      return NextResponse.json({ ok: true, enqueued: enqueued.length, tasks: enqueued, kind, refId });
    }

    // ========== 场景空镜：支持批量（无 refId → 全部场景） ==========
    if (kind === "scene" && !refId) {
      const scenes = await prisma.scene.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } });
      if (scenes.length === 0) return NextResponse.json({ error: "暂无场景，请先生成剧本" }, { status: 404 });

      const enqueued: { sceneId: string; taskId: string }[] = [];
      for (const scene of scenes) {
        const prompt = await sceneDesignPrompt(
          { name: scene.name, description: scene.description, mood: scene.mood, refImageIds: scene.refImageIds },
          anchor,
          id
        );
        const task = await prisma.genTask.create({
          data: {
            projectId: id,
            label: `场景空镜·${scene.name}`,
            type: "IMAGE",
            provider: "seedream",
            model: "seedream-5-0",
            refType: "scene",
            refId: scene.id,
            status: "QUEUED",
            input: { kind, prompt: prompt.slice(0, 500), refImages: scene.refImageIds.length } as never,
          },
        });
        await enqueueGenTask("image", {
          taskId: task.id,
          payload: {
            prompt,
            refImages: scene.refImageIds,
            count: 1,
            aspectRatio: "16:9",
            refType: "scene",
            refId: scene.id,
            category: "scenes",
          },
        });
        enqueued.push({ sceneId: scene.id, taskId: task.id });
      }
      return NextResponse.json({ ok: true, enqueued: enqueued.length, tasks: enqueued, kind, refId });
    }

    // ========== 场景 / 道具：单任务 ==========
    let label = "";
    let prompt = "";
    let refImages: string[] = [];
    let refType: "scene" | "asset" = "scene";
    let refTargetId: string | undefined = refId;
    const count = 1;

    if (kind === "scene") {
      const scene = refId
        ? await prisma.scene.findFirst({ where: { id: refId, projectId: id } })
        : null;
      if (!scene) return NextResponse.json({ error: "场景不存在" }, { status: 404 });
      prompt = await sceneDesignPrompt(
        { name: scene.name, description: scene.description, mood: scene.mood, refImageIds: scene.refImageIds },
        anchor,
        id
      );
      refImages = scene.refImageIds;
      label = `场景空镜·${scene.name}`;
      refType = "scene";
    } else {
      const name = body?.name ? String(body.name) : "未命名道具";
      const desc = body?.desc ? String(body.desc) : "";
      // 道具走 Asset 表（type PROP）
      let asset = refId ? await prisma.asset.findFirst({ where: { id: refId, projectId: id, type: "PROP" } }) : null;
      if (!asset) {
        asset = await prisma.asset.create({
          data: { projectId: id, type: "PROP", name, meta: { desc } as never, status: "DRAFTING" },
        });
      }
      prompt = await propDesignPrompt(asset.name, desc, anchor, id);
      refImages = asset.imageIds;
      label = `道具设计·${asset.name}`;
      refType = "asset";
      refTargetId = asset.id;
    }

    const task = await prisma.genTask.create({
      data: {
        projectId: id,
        label,
        type: "IMAGE",
        provider: "seedream",
        model: "seedream-5-0",
        refType,
        refId: refTargetId,
        status: "QUEUED",
        input: { kind, prompt: prompt.slice(0, 500), refImages: refImages.length } as never,
      },
    });

    await enqueueGenTask("image", {
      taskId: task.id,
      payload: {
        prompt,
        refImages,
        count,
        aspectRatio: kind === "character" ? "3:4" : "16:9",
        refType,
        refId: refTargetId,
        category: kind === "character" ? "characters" : kind === "scene" ? "scenes" : "props",
      },
    });

    return NextResponse.json({ ok: true, taskId: task.id, kind, refId });
  } catch (e) {
    console.error(`[assets] 操作失败: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}

// ========== GET 聚合 ==========

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  await syncScenes(id);

  const [characters, scenes, props, runningTask] = await Promise.all([
    prisma.character.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } }),
    prisma.scene.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } }),
    prisma.asset.findMany({ where: { projectId: id, type: "PROP" }, orderBy: { createdAt: "asc" } }),
    prisma.genTask.findFirst({
      where: { projectId: id, type: "IMAGE", status: { in: ["QUEUED", "PROCESSING"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return NextResponse.json({
    characters,
    scenes,
    props,
    runningTask: runningTask
      ? { id: runningTask.id, label: runningTask.label, status: runningTask.status, error: runningTask.error }
      : null,
  });
}

// ========== PATCH 一致性锁定 ==========

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const kind = body?.kind as string | undefined;
  const refId = body?.refId ? String(body.refId) : undefined;
  const status = body?.status as AssetStatus | undefined;

  // 音色手动指定：{ kind: "voice", refId, voiceId }
  if (kind === "voice" && refId && body?.voiceId) {
    const voiceId = String(body.voiceId);
    const r = await prisma.character.updateMany({ where: { id: refId, projectId: id }, data: { voiceId } });
    if (r.count === 0) return NextResponse.json({ error: "角色不存在" }, { status: 404 });
    return NextResponse.json({ ok: true, voiceId });
  }

  if (!["character", "scene", "prop"].includes(kind ?? "") || !refId || !["APPROVED", "REJECTED", "DRAFTING"].includes(status ?? "")) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }
  if (kind === "character") {
    await prisma.character.updateMany({ where: { id: refId, projectId: id }, data: { status } });
  } else if (kind === "scene") {
    await prisma.scene.updateMany({ where: { id: refId, projectId: id }, data: { status } });
  } else {
    await prisma.asset.updateMany({ where: { id: refId, projectId: id }, data: { status } });
  }
  return NextResponse.json({ ok: true });
}
