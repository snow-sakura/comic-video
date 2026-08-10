/**
 * BullMQ Worker 处理器 — 与 GenTask 表联动
 * 每个 handler 从 job.data 取 { taskId, ...payload }，
 * 执行后将结果写入 GenTask（DONE/FAILED），视频类任务内部轮询平台状态。
 */
import type { Job, Worker } from "bullmq";
import { Worker as BullWorker } from "bullmq";
import { prisma } from "@/lib/db";
import { getConnection } from "@/lib/queue/connection";
import { QUEUE_DEFS, type QueueName } from "@/lib/queue/queues";
import type { GenTask } from "@/generated/prisma/client";
import type { TaskHandle, TTSSubtitle } from "@/lib/providers/types";
import { estimateSubtitles, probeAudioDuration } from "@/lib/tts/subtitles";
import { getImage, getStructLLM, getTTS, getVideo } from "@/lib/providers/registry";
import { runExtractCharacters, runGenerateOutline, runGenerateEpisode } from "@/lib/agents";
import { runStoryboardEpisode } from "@/lib/storyboard";
import { composeEpisode } from "@/lib/compose";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ========== GenTask 状态联动 ==========

async function markProcessing(taskId: string): Promise<void> {
  await prisma.genTask.update({ where: { id: taskId }, data: { status: "PROCESSING" } }).catch(() => {});
}

async function markDone(taskId: string, result: Record<string, unknown>): Promise<void> {
  await prisma.genTask
    .update({ where: { id: taskId }, data: { status: "DONE", error: null } })
    .catch(() => {});
  return;
}

async function markFailed(taskId: string, error: string): Promise<void> {
  await prisma.genTask
    .update({ where: { id: taskId }, data: { status: "FAILED", error } })
    .catch(() => {});
}

// ========== 各队列处理器 ==========

type Handler = (job: Job) => Promise<Record<string, unknown>>;

/** script: 剧本工坊 LLM 任务（payload: { agent: extract|outline|script|plain, projectId?, episodeNumber?, input? }） */
const scriptHandler: Handler = async (job) => {
  const { taskId, agent, projectId, episodeNumber, input } = job.data as {
    taskId: string;
    agent: string;
    projectId?: string;
    episodeNumber?: number;
    input?: string;
  };
  await markProcessing(taskId);

  let result: Record<string, unknown>;
  switch (agent) {
    case "characters": {
      if (!projectId) throw new Error("缺少 projectId");
      const r = await runExtractCharacters(projectId);
      result = { ...r, agent };
      break;
    }
    case "outline": {
      if (!projectId) throw new Error("缺少 projectId");
      const r = await runGenerateOutline(projectId);
      result = { ...r, agent };
      break;
    }
    case "script": {
      if (!projectId || !episodeNumber) throw new Error("缺少 projectId/episodeNumber");
      const r = await runGenerateEpisode(projectId, episodeNumber);
      result = { episode: r, agent };
      break;
    }
    case "storyboard": {
      if (!projectId || !episodeNumber) throw new Error("缺少 projectId/episodeNumber");
      const r = await runStoryboardEpisode(projectId, episodeNumber);
      result = { ...r, agent };
      break;
    }
    default: {
      // plain：直接透传 LLM 调用（诊断/扩展用）
      const llm = await getStructLLM();
      const out = await llm.chat(
        [
          { role: "system", content: "你是漫剧创作助手。必须输出 JSON。" },
          { role: "user", content: String(input ?? "") },
        ],
        { json: true }
      );
      result = { output: out, agent: "plain" };
    }
  }
  await markDone(taskId, result);
  return result;
};

/** image: 出图任务（payload: { prompt, size, refImages, count, aspectRatio, refType, refId, shotId, category }）
 *  refType/refId: 资产生成时回写到 Character/Scene/Asset 表
 *  shotId: 分镜出图时回写到 Shot 表 */
const imageHandler: Handler = async (job) => {
  const { taskId, prompt, size, refImages, count, aspectRatio, negativePrompt, refType, refId, shotId, category } = job.data;
  await markProcessing(taskId);
  const image = await getImage();
  const handle = await image.generate({
    prompt: String(prompt ?? ""),
    size: size as never,
    refImages: (refImages as string[] | undefined) ?? [],
    count: count ? Number(count) : undefined,
    aspectRatio: aspectRatio as never,
    negativePrompt: negativePrompt ? String(negativePrompt) : undefined,
  });
  if (handle.status === "failed") throw new Error(handle.error ?? "图像生成失败");
  const imagePaths = handle.result?.imagePaths ?? [];

  // 资产生成 → 回写资源表（存相对路径，供后续作为参考图）
  if (refId && imagePaths.length > 0) {
    if (refType === "character") {
      await prisma.character
        .update({ where: { id: refId }, data: { refImageIds: { push: imagePaths } } })
        .catch(() => {});
    } else if (refType === "scene") {
      await prisma.scene
        .update({ where: { id: refId }, data: { refImageIds: { push: imagePaths } } })
        .catch(() => {});
    } else if (refType === "asset") {
      await prisma.asset
        .update({ where: { id: refId }, data: { imageIds: { push: imagePaths } } })
        .catch(() => {});
    }
  }

  // 分镜出图 → 回写 Shot
  if (shotId && imagePaths.length > 0) {
    await prisma.shot
      .update({
        where: { id: shotId },
        data: { imagePath: imagePaths[0], status: "IMAGE_DONE" },
      })
      .catch(() => {});
  }

  const result = { imagePaths };
  await markDone(taskId, result);
  return result;
};

/** video: 视频任务（payload: { shotId, imagePath, prompt, refImages, duration, tailImagePath }）
 *  可灵为异步平台任务：submit → 保存 providerTaskId → 轮询 getTask 直至完成
 *  shotId: 分镜视频生成时回写到 Shot 表（videoPath + VIDEO_DONE） */
const videoHandler: Handler = async (job) => {
  const { taskId, shotId, imagePath, prompt, refImages, duration, tailImagePath } = job.data;
  await markProcessing(taskId);
  const video = await getVideo();

  // 1. 提交
  const submitHandle = await video.submit({
    imagePath: String(imagePath),
    prompt: String(prompt ?? ""),
    refImages: (refImages as string[] | undefined) ?? [],
    duration: (Number(duration) === 10 ? 10 : 5) as 5 | 10,
    tailImagePath: tailImagePath ? String(tailImagePath) : undefined,
  });
  if (submitHandle.status === "done" && submitHandle.result) {
    // 同步型 provider（mock）：直接返回
    const result = { videoPath: (submitHandle.result as { videoPath: string }).videoPath };
    await writeBackShot(job.data, result.videoPath);
    await markDone(taskId, result);
    return result;
  }
  if (submitHandle.status === "failed") {
    throw new Error(submitHandle.error ?? "视频提交失败");
  }
  const providerTaskId = submitHandle.providerTaskId;
  if (!providerTaskId) throw new Error("视频任务缺少 providerTaskId");

  // 2. 保存平台任务 ID（供 UI 展示/恢复）
  await prisma.genTask
    .update({ where: { id: taskId }, data: { providerTaskId } })
    .catch(() => {});

  // 3. 轮询（最长 ~20 分钟）
  const deadline = Date.now() + 20 * 60 * 1000;
  let handle: TaskHandle<{ videoPath: string }> = { taskId, status: "processing" };
  while (Date.now() < deadline) {
    await sleep(10000);
    handle = await video.getTask(providerTaskId);
    if (handle.status === "done") {
      const result = { videoPath: handle.result?.videoPath };
      await writeBackShot(job.data, result.videoPath);
      await markDone(taskId, result);
      return result;
    }
    if (handle.status === "failed") {
      throw new Error(handle.error ?? "视频生成失败");
    }
    await job.updateProgress({ status: "processing" });
  }
  throw new Error("视频生成超时（20分钟）");
};

/** 视频/配音完成后回写 Shot（shotId 存在时） */
async function writeBackShot(
  data: Record<string, unknown>,
  path?: string,
  kind: "video" | "voice" = "video"
): Promise<void> {
  const shotId = data.shotId ? String(data.shotId) : undefined;
  if (!shotId) return;
  if (kind === "video") {
    await prisma.shot
      .update({
        where: { id: shotId },
        data: path ? { videoPath: path, status: "VIDEO_DONE" } : { status: "VIDEO_FAILED" },
      })
      .catch(() => {});
  } else {
    await prisma.shot
      .update({
        where: { id: shotId },
        data: path ? { voicePath: path, status: "VOICE_DONE" } : { status: "VOICE_FAILED" },
      })
      .catch(() => {});
  }
}

/** audio: TTS 任务（payload: { shotId, text, voiceId, emotion, rate, sampleRate }）
 *  shotId: 分镜配音时回写到 Shot 表（voicePath/subtitlePath + VOICE_DONE） */
const audioHandler: Handler = async (job) => {
  const { taskId, shotId, text, voiceId, emotion, rate, sampleRate } = job.data;
  await markProcessing(taskId);
  const tts = await getTTS();
  const handle = await tts.synthesize({
    text: String(text ?? ""),
    voiceId: String(voiceId ?? ""),
    emotion: emotion ? String(emotion) : undefined,
    rate: rate ? Number(rate) : undefined,
    sampleRate: sampleRate ? Number(sampleRate) as 16000 | 24000 | 48000 : undefined,
  });
  if (handle.status === "failed") throw new Error(handle.error ?? "TTS 合成失败");
  const result = {
    audioPath: handle.result?.audioPath,
    subtitles: (handle.result as { subtitles?: unknown } | undefined)?.subtitles ?? undefined,
  };
  // 字幕兜底：provider 未返回逐句时间戳时，按真实音频时长估算
  let subtitles = Array.isArray(result.subtitles) && (result.subtitles as unknown[]).length
    ? (result.subtitles as TTSSubtitle[])
    : undefined;
  if (!subtitles && result.audioPath) {
    try {
      const dur = await probeAudioDuration(result.audioPath);
      subtitles = estimateSubtitles(String(text ?? ""), dur);
    } catch {
      // 探测失败不阻断配音
    }
  }
  // 分镜配音 → 回写 Shot
  if (shotId && result.audioPath) {
    await prisma.shot
      .update({
        where: { id: shotId },
        data: {
          voicePath: String(result.audioPath),
          subtitlePath: subtitles ? JSON.stringify(subtitles) : undefined,
          status: "VOICE_DONE",
        },
      })
      .catch(() => {});
  }
  await markDone(taskId, { ...result, subtitles });
  return { ...result, subtitles };
};

/** compose: 最终合成（payload: { episodeId, bgmMood }）→ ffmpeg 拼接成片 */
const composeHandler: Handler = async (job) => {
  const { taskId, episodeId, bgmMood } = job.data as {
    taskId: string;
    episodeId?: string;
    bgmMood?: string;
  };
  await markProcessing(taskId);
  if (!episodeId) throw new Error("缺少 episodeId");
  const result = await composeEpisode(episodeId, bgmMood);
  await markDone(taskId, result);
  return result;
};

const HANDLERS: Record<QueueName, Handler> = {
  script: scriptHandler,
  image: imageHandler,
  video: videoHandler,
  audio: audioHandler,
  compose: composeHandler,
};

// ========== Worker 生命周期 ==========

const workers = new Map<QueueName, Worker>();

/** 启动指定队列的 worker（生产进程调用） */
export function startWorker(name: QueueName): Worker {
  if (workers.has(name)) return workers.get(name)!;
  const worker = new BullWorker(
    QUEUE_DEFS[name].name,
    async (job) => {
      try {
        return await HANDLERS[name](job);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const { taskId } = job.data as { taskId?: string };
        if (taskId && job.attemptsMade + 1 >= (job.opts.attempts ?? 3)) {
          await markFailed(taskId, msg);
        }
        throw e; // 交给 BullMQ 重试
      }
    },
    {
      connection: getConnection(),
      concurrency: QUEUE_DEFS[name].concurrency,
    }
  );
  worker.on("failed", (job, err) => {
    console.error(`[queue:${name}] job ${job?.id} failed: ${err.message}`);
  });
  workers.set(name, worker);
  return worker;
}

export function startAllWorkers(): Worker[] {
  return (Object.keys(QUEUE_DEFS) as QueueName[]).map((name) => startWorker(name));
}

export async function closeWorkers(): Promise<void> {
  await Promise.all([...workers.values()].map((w) => w.close()));
  workers.clear();
}

export type { GenTask };
