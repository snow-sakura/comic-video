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
import type { AssetStatus } from "@/generated/prisma/client";

// ========== 场景惰性同步（从剧本提取） ==========

async function syncScenes(projectId: string): Promise<void> {
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
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const kind = body?.kind as string | undefined;
  const refId = body?.refId ? String(body.refId) : undefined;
  const regenerate = body?.regenerate === true;

  if (!["character", "scene", "prop"].includes(kind ?? "")) {
    return NextResponse.json({ error: "kind 必须是 character | scene | prop" }, { status: 400 });
  }

  // 运行中任务保护
  const running = await prisma.genTask.findFirst({
    where: { projectId: id, type: "IMAGE", status: { in: ["QUEUED", "PROCESSING"] } },
  });
  if (running) {
    return NextResponse.json({ error: "已有图像任务进行中", runningTaskId: running.id }, { status: 409 });
  }

  const anchor = styleAnchor(project.style as never);
  let label = "";
  let prompt = "";
  let refImages: string[] = [];
  let refType: "character" | "scene" | "asset" = "character";
  let refTargetId: string | undefined = refId;
  let count = 1;

  if (kind === "character") {
    const character = refId
      ? await prisma.character.findFirst({ where: { id: refId, projectId: id } })
      : null;
    if (!character) return NextResponse.json({ error: "角色不存在" }, { status: 404 });
    const c = character.appearance as never as { hair?: string; costume?: string; facialMarkers?: string; body?: string; style?: string };
    const input = {
      name: character.name,
      role: character.role,
      appearance: {
        hair: c.hair ?? "待定",
        costume: c.costume ?? "待定",
        facialMarkers: c.facialMarkers ?? "待定",
        body: c.body ?? "待定",
        style: c.style ?? "待定",
      },
      refImageIds: character.refImageIds,
    };
    // 有已锁定定妆照时用其做参考图（多角度补全）；否则 3 张组图（正面/侧面/全身）
    if (!regenerate && character.refImageIds.length > 0 && character.status === "APPROVED") {
      refImages = character.refImageIds;
      prompt = characterDesignPrompt(input, anchor, "three-quarter");
      count = 1;
    } else {
      prompt = [
        characterDesignPrompt(input, anchor, "front"),
        "另附两张：四分之三侧面像 + 全身像（同一角色，保持外观完全一致）",
      ].join("\n");
      count = 3;
    }
    label = `角色定妆照·${character.name}`;
    refType = "character";
  } else if (kind === "scene") {
    const scene = refId
      ? await prisma.scene.findFirst({ where: { id: refId, projectId: id } })
      : null;
    if (!scene) return NextResponse.json({ error: "场景不存在" }, { status: 404 });
    prompt = sceneDesignPrompt(
      { name: scene.name, description: scene.description, mood: scene.mood, refImageIds: scene.refImageIds },
      anchor
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
    prompt = propDesignPrompt(asset.name, desc, anchor);
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
