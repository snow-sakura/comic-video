/**
 * /api/projects/[id]/storyboard — 分镜车间
 * POST { stage: "storyboard"|"images", episodeNumber, shotId? }
 *   storyboard → 分镜 Agent（场景→镜头 + 7维提示词组装）
 *   images     → 该集全部镜头批量入队 image 队列（可指定单镜头重试）
 * GET — 集列表 + 各集镜头统计 + 运行中任务
 * PATCH { shotId, status } — 标记 REJECTED（重新生成）/ 重置
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueGenTask } from "@/lib/queue/queues";
import { runStoryboardEpisode } from "@/lib/storyboard";

// ========== POST ==========

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const stage = body?.stage as string | undefined;
  const episodeNumber = Number(body?.episodeNumber);
  const shotId = body?.shotId ? String(body.shotId) : undefined;

  if (!Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    return NextResponse.json({ error: "episodeNumber 无效" }, { status: 400 });
  }
  const episode = await prisma.episode.findUnique({
    where: { projectId_number: { projectId: id, number: episodeNumber } },
  });
  if (!episode) return NextResponse.json({ error: "该集不存在，请先完成剧本" }, { status: 404 });

  if (stage === "storyboard") {
    // 运行中保护
    const running = await prisma.genTask.findFirst({
      where: { projectId: id, type: "LLM", status: { in: ["QUEUED", "PROCESSING"] } },
    });
    if (running) return NextResponse.json({ error: "已有任务进行中", runningTaskId: running.id }, { status: 409 });

    const task = await prisma.genTask.create({
      data: {
        projectId: id,
        label: `分镜·第${episodeNumber}集`,
        type: "LLM",
        provider: "script-agent",
        model: "storyboard",
        status: "QUEUED",
        input: { stage, episodeNumber } as never,
      },
    });
    await enqueueGenTask("script", {
      taskId: task.id,
      payload: { agent: "storyboard", projectId: id, episodeNumber },
    });
    return NextResponse.json({ ok: true, taskId: task.id });
  }

  if (stage === "images") {
    // 批量出图：目标镜头
    const targets = shotId
      ? await prisma.shot.findMany({ where: { id: shotId, episodeId: episode.id } })
      : await prisma.shot.findMany({ where: { episodeId: episode.id }, orderBy: { sequence: "asc" } });
    if (targets.length === 0) return NextResponse.json({ error: "该集暂无镜头，请先执行分镜" }, { status: 400 });

    const ready = targets.filter((s) => s.finalPrompt && s.status !== "IMAGE_GENERATING");
    if (ready.length === 0) return NextResponse.json({ error: "目标镜头均无提示词或正在生成" }, { status: 400 });

    const running = await prisma.genTask.count({
      where: { projectId: id, type: "IMAGE", status: { in: ["QUEUED", "PROCESSING"] } },
    });
    if (running > 0 && !shotId) {
      return NextResponse.json({ error: "已有图像任务进行中", runningTaskId: "bulk" }, { status: 409 });
    }

    const enqueued: string[] = [];
    for (const shot of ready) {
      const task = await prisma.genTask.create({
        data: {
          projectId: id,
          label: `分镜图·第${episodeNumber}集#${shot.sequence}`,
          type: "IMAGE",
          provider: "seedream",
          model: "seedream-5-0",
          refType: "shot",
          refId: shot.id,
          status: "QUEUED",
          input: { shotId: shot.id, episodeNumber } as never,
        },
      });
      await prisma.shot.update({ where: { id: shot.id }, data: { status: "IMAGE_GENERATING" } });
      await enqueueGenTask("image", {
        taskId: task.id,
        payload: {
          prompt: shot.finalPrompt,
          refImages: shot.refImages,
          count: 1,
          aspectRatio: "16:9",
          shotId: shot.id,
          category: "shots",
        },
      });
      enqueued.push(shot.id);
    }
    return NextResponse.json({ ok: true, enqueued: enqueued.length, shotIds: enqueued });
  }

  return NextResponse.json({ error: "stage 必须是 storyboard | images" }, { status: 400 });
}

// ========== GET ==========

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const [episodes, running] = await Promise.all([
    prisma.episode.findMany({
      where: { projectId: id },
      orderBy: { number: "asc" },
      include: { shots: { orderBy: { sequence: "asc" } } },
    }),
    prisma.genTask.findFirst({
      where: { projectId: id, type: { in: ["LLM", "IMAGE"] }, status: { in: ["QUEUED", "PROCESSING"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return NextResponse.json({
    episodes: episodes.map((e) => ({
      id: e.id,
      number: e.number,
      title: e.title,
      status: e.status,
      shots: e.shots.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        sceneName: s.sceneName,
        camera: s.camera,
        action: s.action,
        dialog: s.dialog,
        dialogChar: s.dialogChar,
        dialogEmotion: s.dialogEmotion,
        duration: s.duration,
        finalPrompt: s.finalPrompt,
        imagePath: s.imagePath,
        status: s.status,
        error: s.error,
        refImages: s.refImages,
      })),
    })),
    runningTask: running
      ? { id: running.id, label: running.label, status: running.status, error: running.error }
      : null,
  });
}

// ========== PATCH 镜头重审 ==========

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const shotId = body?.shotId ? String(body.shotId) : undefined;
  if (!shotId) return NextResponse.json({ error: "缺少 shotId" }, { status: 400 });

  const shot = await prisma.shot.findFirst({ where: { id: shotId, episode: { projectId: id } } });
  if (!shot) return NextResponse.json({ error: "镜头不存在" }, { status: 404 });

  if (body?.status === "REJECTED") {
    await prisma.shot.update({ where: { id: shotId }, data: { status: "REJECTED", error: null } });
    return NextResponse.json({ ok: true });
  }
  if (body?.status === "PENDING") {
    // 重置：清空图，供重新出图
    await prisma.shot.update({ where: { id: shotId }, data: { status: "PROMPT_READY", imagePath: null, error: null } });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "status 必须是 REJECTED | PENDING" }, { status: 400 });
}
