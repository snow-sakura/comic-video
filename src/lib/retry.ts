/**
 * 任务重试：从 GenTask 元数据 + 业务表重建 payload 重新入队。
 * 支持 script-agent(LLM) / seedream(图) / kling(视频) / cosyvoice(配音) / ffmpeg(合成)。
 */
import { prisma } from "@/lib/db";
import { enqueueGenTask } from "@/lib/queue/queues";
import { buildMotionPrompt } from "@/lib/compose/prompts";

export interface RetryResult {
  ok: boolean;
  error?: string;
}

export async function retryGenTask(taskId: string): Promise<RetryResult> {
  const task = await prisma.genTask.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false, error: "任务不存在" };
  if (!["FAILED", "REJECTED"].includes(task.status)) {
    return { ok: false, error: "仅失败/拒绝状态的任务可重试" };
  }

  const input = (task.input ?? {}) as { episodeNumber?: number; shotId?: string };
  const episodeNumber = Number(input.episodeNumber) || undefined;
  // 重试必须用新 jobId（BullMQ 相同 jobId 已完成任务不会重复执行）
  const retryJobId = `${taskId}_retry_${Date.now()}`;
  const reset = (shotId: string | null, status: string) =>
    shotId ? prisma.shot.update({ where: { id: shotId }, data: { status } as never }).catch(() => {}) : Promise.resolve();

  await prisma.genTask.update({ where: { id: taskId }, data: { status: "QUEUED", error: null } });

  switch (task.provider) {
    case "script-agent": {
      await enqueueGenTask("script", {
        taskId, jobId: retryJobId,
        payload: { agent: task.model, projectId: task.projectId, episodeNumber },
      });
      return { ok: true };
    }
    case "seedream": {
      const shot = task.refId ? await prisma.shot.findUnique({ where: { id: task.refId } }) : null;
      if (!shot) return { ok: false, error: "关联镜头不存在，请在分镜车间重新出图" };
      await reset(shot.id, "IMAGE_GENERATING");
      await enqueueGenTask("image", {
        taskId, jobId: retryJobId,
        payload: {
          prompt: shot.finalPrompt,
          refImages: shot.refImages,
          count: 1,
          aspectRatio: "16:9",
          shotId: shot.id,
        },
      });
      return { ok: true };
    }
    case "kling": {
      const shot = task.refId ? await prisma.shot.findUnique({ where: { id: task.refId } }) : null;
      if (!shot) return { ok: false, error: "关联镜头不存在，请先在分镜车间出图" };
      if (!shot.imagePath) return { ok: false, error: "镜头没有分镜图，请先出图" };
      await reset(shot.id, "VIDEO_GENERATING");
      await enqueueGenTask("video", {
        taskId, jobId: retryJobId,
        payload: { shotId: shot.id, imagePath: shot.imagePath, prompt: buildMotionPrompt(shot), duration: 5 },
      });
      return { ok: true };
    }
    case "cosyvoice": {
      const shot = task.refId ? await prisma.shot.findUnique({ where: { id: task.refId } }) : null;
      if (!shot) return { ok: false, error: "关联镜头不存在" };
      if (!shot.dialog) return { ok: false, error: "镜头没有台词，无法配音" };
      const voiceByChar = await getVoiceMap(shot.episodeId);
      await reset(shot.id, "VOICE_GENERATING");
      await enqueueGenTask("audio", {
        taskId, jobId: retryJobId,
        payload: {
          shotId: shot.id,
          text: shot.dialog,
          voiceId: shot.dialogChar ? voiceByChar.get(shot.dialogChar) ?? undefined : undefined,
          emotion: shot.dialogEmotion ?? undefined,
        },
      });
      return { ok: true };
    }
    case "ffmpeg": {
      const episodeId = task.refId ?? undefined;
      if (!episodeId) return { ok: false, error: "缺少剧集信息，请在视频合成厂重新合成" };
      await enqueueGenTask("compose", {
        taskId, jobId: retryJobId,
        payload: { episodeId, bgmMood: undefined },
      });
      return { ok: true };
    }
    default:
      return { ok: false, error: `不支持的 provider: ${task.provider}` };
  }
}

/** 该集角色 → 声音 ID 映射（与 compose 路由一致） */
async function getVoiceMap(episodeId: string): Promise<Map<string, string>> {
  const episode = await prisma.episode.findUnique({ where: { id: episodeId } });
  if (!episode) return new Map();
  const chars = await prisma.character.findMany({ where: { projectId: episode.projectId } });
  return new Map(chars.filter((c) => c.voiceId).map((c) => [c.name, c.voiceId as string]));
}
