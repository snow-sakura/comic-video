/**
 * /api/projects/[id]/storyboard — 分镜车间
 * POST { stage: "storyboard"|"images", episodeNumber, shotId? }
 *   storyboard → 分镜 Agent（场景→镜头 + 7维提示词组装）
 *   images     → 该集全部镜头批量入队 image 队列（可指定单镜头重试）
 * GET — 集列表 + 各集镜头统计 + 运行中任务
 * PATCH { shotId, status } — 标记 REJECTED（重新生成）/ 重置
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { enqueueGenTask } from "@/lib/queue/queues";
import { assembleAllShotPrompts } from "@/lib/storyboard";

const storyboardSchema = z.object({
  stage: z.enum(["storyboard", "images", "manual"]),
  episodeNumber: z.number().int().min(1),
  shotId: z.string().optional(),
  shots: z.array(z.object({
    sceneName: z.string().optional(),
    action: z.string().optional(),
    dialog: z.string().optional(),
    dialogChar: z.string().optional(),
    dialogEmotion: z.string().optional(),
    duration: z.number().min(0.5).max(60).optional(),
  })).optional(),
});

const shotPatchSchema = z.object({
  shotId: z.string().min(1),
  status: z.enum(["REJECTED"]),
});

// ========== POST ==========

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const raw = await req.json().catch(() => ({}));
    const parsed = storyboardSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "输入校验失败", details: parsed.error.flatten() }, { status: 400 });
    }
    const { stage, episodeNumber, shotId, shots } = parsed.data;
    const body = raw;
    const episode = await prisma.episode.findUnique({
      where: { projectId_number: { projectId: id, number: episodeNumber } },
    });
    if (!episode) return NextResponse.json({ error: "该集不存在，请先完成剧本" }, { status: 404 });

    if (stage === "manual") {
      // P1-4 手动分镜：手动创建镜头（复用同一套提示词/参考图组装）
      const items = shots ?? [];
      if (items.length === 0) return NextResponse.json({ error: "shots 不能为空" }, { status: 400 });
      const maxSeq = await prisma.shot.aggregate({
        where: { episodeId: episode.id },
        _max: { sequence: true },
      });
      let seq = (maxSeq._max.sequence ?? 0) + 1;
      const created: string[] = [];
      for (const it of items) {
        const action = typeof it.action === "string" ? it.action.trim() : "";
        const dialog = typeof it.dialog === "string" ? it.dialog.trim() : "";
        if (!action && !dialog) continue; // 空镜头跳过
        const shot = await prisma.shot.create({
          data: {
            episodeId: episode.id,
            sequence: seq++,
            sceneName: typeof it.sceneName === "string" ? it.sceneName.trim() : null,
            camera: { angle: "平视", movement: "固定", shotSize: "中景" } as never,
            action: action || null,
            dialog: dialog || null,
            dialogChar: typeof it.dialogChar === "string" ? it.dialogChar.trim() : null,
            dialogEmotion: typeof it.dialogEmotion === "string" ? it.dialogEmotion.trim() : null,
            duration: Number(it.duration) > 0 ? Number(it.duration) : 5,
            status: "PENDING",
          },
        });
        created.push(shot.id);
      }
      if (created.length === 0) return NextResponse.json({ error: "没有有效镜头（至少填动作或台词）" }, { status: 400 });
      // 组装 7 维提示词 + 锁定参考图（幂等，AI 分镜与手动镜头统一处理）
      await assembleAllShotPrompts(id, episode.id);
      return NextResponse.json({ ok: true, created: created.length });
    }

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

    return NextResponse.json({ error: "stage 必须是 storyboard | images | manual" }, { status: 400 });
  } catch (e) {
    console.error(`[storyboard] 操作失败: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
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
  const raw = await req.json().catch(() => ({}));
  const parsed = shotPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "输入校验失败", details: parsed.error.flatten() }, { status: 400 });
  }
  const { shotId, status } = parsed.data;

  const shot = await prisma.shot.findFirst({ where: { id: shotId, episode: { projectId: id } } });
  if (!shot) return NextResponse.json({ error: "镜头不存在" }, { status: 404 });

  if (status === "REJECTED") {
    await prisma.shot.update({ where: { id: shotId }, data: { status: "REJECTED", error: null } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "status 必须是 REJECTED" }, { status: 400 });
}
