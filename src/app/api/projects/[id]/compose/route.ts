/**
 * /api/projects/[id]/compose — 视频合成厂
 * POST { stage: "video"|"voice"|"compose", episodeNumber, shotId?, bgmMood? }
 *   video   → 该集全部 IMAGE_DONE 镜头入队 video 队列（图生视频，可指定单镜头）
 *   voice   → 该集全部 VIDEO_DONE 且有台词的镜头入队 audio 队列（TTS 配音）
 *   compose → 该集入队 compose 队列（ffmpeg 拼接 + 可选 BGM）
 * GET — 集列表 + 镜头（video/voice/成片状态）+ 运行中任务
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueGenTask } from "@/lib/queue/queues";
import { buildMotionPrompt } from "@/lib/compose/prompts";

// ========== POST ==========

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const stage = body?.stage as string | undefined;
    const episodeNumber = Number(body?.episodeNumber);
    const shotId = body?.shotId ? String(body.shotId) : undefined;
    const bgmMood = body?.bgmMood ? String(body.bgmMood) : undefined;

    if (!Number.isInteger(episodeNumber) || episodeNumber <= 0) {
      return NextResponse.json({ error: "episodeNumber 无效" }, { status: 400 });
    }
    const episode = await prisma.episode.findUnique({
      where: { projectId_number: { projectId: id, number: episodeNumber } },
    });
    if (!episode) return NextResponse.json({ error: "该集不存在，请先完成剧本" }, { status: 404 });

    // 通用：取目标镜头
    const targets = shotId
      ? await prisma.shot.findMany({ where: { id: shotId, episodeId: episode.id } })
      : await prisma.shot.findMany({ where: { episodeId: episode.id }, orderBy: { sequence: "asc" } });

    if (stage === "video") {
      if (targets.length === 0) return NextResponse.json({ error: "该集暂无镜头，请先完成分镜" }, { status: 400 });
      const ready = targets.filter((s) => s.imagePath && s.status !== "VIDEO_GENERATING");
      if (ready.length === 0) return NextResponse.json({ error: "目标镜头均无分镜图或正在生成视频" }, { status: 400 });

      const running = await prisma.genTask.count({
        where: { projectId: id, type: "VIDEO", status: { in: ["QUEUED", "PROCESSING"] } },
      });
      if (running > 0 && !shotId) {
        return NextResponse.json({ error: "已有视频任务进行中", runningTaskId: "bulk" }, { status: 409 });
      }

      const enqueued: string[] = [];
      for (const shot of ready) {
        const task = await prisma.genTask.create({
          data: {
            projectId: id,
            label: `视频·第${episodeNumber}集#${shot.sequence}`,
            type: "VIDEO",
            provider: "kling",
            model: "kling-3-0-omni",
            refType: "shot",
            refId: shot.id,
            status: "QUEUED",
            input: { shotId: shot.id, episodeNumber } as never,
          },
        });
        await prisma.shot.update({ where: { id: shot.id }, data: { status: "VIDEO_GENERATING" } });
        await enqueueGenTask("video", {
          taskId: task.id,
          payload: {
            shotId: shot.id,
            imagePath: shot.imagePath,
            prompt: buildMotionPrompt(shot),
            duration: 5,
          },
        });
        enqueued.push(shot.id);
      }
      return NextResponse.json({ ok: true, enqueued: enqueued.length, shotIds: enqueued });
    }

    if (stage === "voice") {
      if (targets.length === 0) return NextResponse.json({ error: "该集暂无镜头，请先完成分镜" }, { status: 400 });
      const ready = targets.filter(
        (s) => s.dialog && s.status !== "VOICE_GENERATING" && (s.videoPath || s.imagePath)
      );
      if (ready.length === 0) return NextResponse.json({ error: "目标镜头均无台词或正在配音" }, { status: 400 });

      const running = await prisma.genTask.count({
        where: { projectId: id, type: "TTS", status: { in: ["QUEUED", "PROCESSING"] } },
      });
      if (running > 0 && !shotId) {
        return NextResponse.json({ error: "已有配音任务进行中", runningTaskId: "bulk" }, { status: 409 });
      }

      // 角色 → 音色映射（角色提炼的 voiceName 建议）
      const chars = await prisma.character.findMany({ where: { projectId: id } });
      const voiceByChar = new Map(chars.map((c) => [c.name, c.voiceName]));

      const enqueued: string[] = [];
      for (const shot of ready) {
        const task = await prisma.genTask.create({
          data: {
            projectId: id,
            label: `配音·第${episodeNumber}集#${shot.sequence}${shot.dialogChar ? `·${shot.dialogChar}` : ""}`,
            type: "TTS",
            provider: "cosyvoice",
            model: "cosyvoice-v2",
            refType: "shot",
            refId: shot.id,
            status: "QUEUED",
            input: { shotId: shot.id, episodeNumber } as never,
          },
        });
        await prisma.shot.update({ where: { id: shot.id }, data: { status: "VOICE_GENERATING" } });
        await enqueueGenTask("audio", {
          taskId: task.id,
          payload: {
            shotId: shot.id,
            text: shot.dialog,
            voiceId: shot.dialogChar ? voiceByChar.get(shot.dialogChar) ?? undefined : undefined,
            emotion: shot.dialogEmotion ?? undefined,
          },
        });
        enqueued.push(shot.id);
      }
      return NextResponse.json({ ok: true, enqueued: enqueued.length, shotIds: enqueued });
    }

    if (stage === "compose") {
      if (targets.length === 0) return NextResponse.json({ error: "该集暂无镜头" }, { status: 400 });
      const withVideo = targets.filter((s) => s.videoPath);
      if (withVideo.length === 0) {
        return NextResponse.json({ error: "该集还没有视频片段，请先生成视频" }, { status: 400 });
      }
      const running = await prisma.genTask.findFirst({
        where: { projectId: id, type: "COMPOSE", status: { in: ["QUEUED", "PROCESSING"] } },
      });
      if (running) return NextResponse.json({ error: "已有合成任务进行中", runningTaskId: running.id }, { status: 409 });

      const task = await prisma.genTask.create({
        data: {
          projectId: id,
          label: `合成·第${episodeNumber}集`,
          type: "COMPOSE",
          provider: "ffmpeg",
          model: "compose",
          status: "QUEUED",
          input: { episodeId: episode.id, bgmMood } as never,
        },
      });
      await prisma.episode.update({ where: { id: episode.id }, data: { status: "composing" } });
      await enqueueGenTask("compose", {
        taskId: task.id,
        payload: { episodeId: episode.id, bgmMood },
      });
      return NextResponse.json({ ok: true, taskId: task.id });
    }

    return NextResponse.json({ error: "stage 必须是 video | voice | compose" }, { status: 400 });
  } catch (e) {
    console.error(`[compose] 操作失败: ${e instanceof Error ? e.message : String(e)}`);
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
      where: { projectId: id, type: { in: ["VIDEO", "TTS", "COMPOSE"] }, status: { in: ["QUEUED", "PROCESSING"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return NextResponse.json({
    episodes: episodes.map((e) => ({
      id: e.id,
      number: e.number,
      title: e.title,
      status: e.status,
      finalPath: e.finalPath,
      shots: e.shots.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        sceneName: s.sceneName,
        action: s.action,
        dialog: s.dialog,
        dialogChar: s.dialogChar,
        duration: s.duration,
        imagePath: s.imagePath,
        videoPath: s.videoPath,
        voicePath: s.voicePath,
        subtitlePath: s.subtitlePath,
        status: s.status,
        error: s.error,
      })),
    })),
    runningTask: running
      ? { id: running.id, label: running.label, status: running.status, error: running.error }
      : null,
  });
}
