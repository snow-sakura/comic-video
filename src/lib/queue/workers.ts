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
import { recordCost } from "@/lib/cost";
import { getImage, getStructLLM, getTTS, getVideo } from "@/lib/providers/registry";
import { runExtractCharacters, runGenerateOutline, runGenerateEpisode } from "@/lib/agents";
import { runStoryboardEpisode } from "@/lib/storyboard";
import { composeEpisode } from "@/lib/compose";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ========== GenTask 状态联动 ==========

async function markProcessing(taskId: string): Promise<void> {
  await prisma.genTask.update({ where: { id: taskId }, data: { status: "PROCESSING" } }).catch(() => {});
}

async function markDone(taskId: string): Promise<void> {
  await prisma.genTask
    .update({ where: { id: taskId }, data: { status: "DONE", error: null } })
    .catch(() => {});
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
  console.log(`[script] 开始处理 job=${job.id} agent=${agent} projectId=${projectId}`);
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
  // 费用估算（LLM：输入按 novel 规模，输出按实际结果字符数）
  let inputChars = input ? String(input).length : 0;
  if (projectId) {
    const proj = await prisma.project
      .findUnique({ where: { id: projectId }, select: { novelText: true } })
      .catch(() => null);
    inputChars = proj?.novelText?.length ?? inputChars;
  }
  await recordCost(taskId, {
    kind: "llm",
    inputChars,
    outputChars: JSON.stringify(result).length,
  });
  await markDone(taskId);
  return result;
};

/** image: 出图任务（payload: { prompt, size, refImages, count, aspectRatio, refType, refId, shotId, category }）
 *  refType/refId: 资产生成时回写到 Character/Scene/Asset 表
 *  shotId: 分镜出图时回写到 Shot 表 */
const imageHandler: Handler = async (job) => {
  const { taskId, prompt, size, refImages, count, aspectRatio, negativePrompt, refType, refId, shotId } = job.data;
  const shotIdStr = shotId ? String(shotId) : undefined;
  await markProcessing(taskId);
  try {
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
    if (shotIdStr && imagePaths.length > 0) {
      await prisma.shot
        .update({
          where: { id: shotIdStr },
          data: { imagePath: imagePaths[0], status: "IMAGE_DONE" },
        })
        .catch(() => {});
    }

    const result = { imagePaths };
    await recordCost(taskId, { kind: "image", count: imagePaths.length });
    await markDone(taskId);
    return result;
  } catch (e) {
    // 出图失败回写 Shot 为 IMAGE_FAILED，避免分镜卡片永远停留在"生成中"
    if (shotIdStr) {
      await prisma.shot
        .update({ where: { id: shotIdStr }, data: { status: "IMAGE_FAILED" } })
        .catch(() => {});
    }
    throw e;
  }
};

/** video: 视频任务（payload: { shotId, imagePath, prompt, refImages, duration, tailImagePath }）
 *  可灵为异步平台任务：submit → 保存 providerTaskId → 轮询 getTask 直至完成
 *  shotId: 分镜视频生成时回写到 Shot 表（videoPath + VIDEO_DONE） */
const videoHandler: Handler = async (job) => {
  const { taskId, imagePath, prompt, refImages, duration, tailImagePath } = job.data;
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
    await qcVideoOrThrow(result.videoPath, job.attemptsMade);
    await recordCost(taskId, { kind: "video", count: 1 });
    await writeBackShot(job.data, result.videoPath);
    await markDone(taskId);
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
      if (result.videoPath) await qcVideoOrThrow(result.videoPath, job.attemptsMade);
      await recordCost(taskId, { kind: "video", count: 1 });
      await writeBackShot(job.data, result.videoPath);
      await markDone(taskId);
      return result;
    }
    if (handle.status === "failed") {
      throw new Error(handle.error ?? "视频生成失败");
    }
    await job.updateProgress({ status: "processing" });
  }
  throw new Error("视频生成超时（20分钟）");
};

/** 视频 QC 封装：WARN 记录日志，FAIL 抛错（触发队列重试，attempts=3 → 至多重试 2 次） */
async function qcVideoOrThrow(relPath: string, attemptsMade: number): Promise<void> {
  const { qcVideo } = await import("@/lib/quality");
  const r = await qcVideo(relPath);
  for (const w of r.warnings) console.warn(`[qc:video] WARN ${relPath}: ${w}`);
  if (!r.ok) {
    const msg = `QC 未通过: ${r.errors.join("; ")}`;
    console.error(`[qc:video] FAIL ${relPath} (attempt ${attemptsMade + 1}): ${msg}`);
    throw new Error(msg);
  }
  console.log(`[qc:video] PASS ${relPath}${attemptsMade > 0 ? ` (重试后成功, attempt ${attemptsMade + 1})` : ""}`);
}

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
  // 费用估算：按真实音频时长（分钟单价）
  if (result.audioPath) {
    try {
      const dur = await probeAudioDuration(result.audioPath);
      await recordCost(taskId, { kind: "audio", durationSec: dur });
    } catch {
      // 忽略
    }
  }
  await markDone(taskId);
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
  await recordCost(taskId, { kind: "compose" });
  await markDone(taskId);
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
      // stalled job 检测：Worker 每 stalledInterval ms 向 Redis 续期，
      // 超过 stalledInterval 未续期视为 stalled（进程崩溃/OOM/kill -9），
      // 由其他 Worker 重投（maxStalledCount 次后永久失败）。
      // 配合 worker.on("failed") 兜底，确保崩溃后任务不卡 PROCESSING。
      stalledInterval: 30000, // 30s 检测一次（默认 30s）
      maxStalledCount: 1, // 重投 1 次后永久失败（视频任务昂贵，避免无限重投）
    }
  );
  worker.on("failed", (job, err) => {
    console.error(`[queue:${name}] job ${job?.id} failed: ${err.message}`);
    // 兜底：进程崩溃（OOM/kill -9）后 stalled job 最终失败时，processor 的 catch
    // 块不会执行，此处用条件更新确保 GenTask 不会卡在 PROCESSING（仅 QUEUED/PROCESSING → FAILED）
    const { taskId } = (job?.data ?? {}) as { taskId?: string };
    if (taskId) {
      prisma.genTask
        .updateMany({
          where: { id: taskId, status: { in: ["QUEUED", "PROCESSING"] } },
          data: { status: "FAILED", error: err.message },
        })
        .catch(() => {});
    }
  });
  // Worker 级错误（如 Redis 断连）必须监听，否则 EventEmitter 无 listener 会触发
  // uncaughtException 导致进程崩溃
  worker.on("error", (err) => {
    console.error(`[queue:${name}] worker error: ${err.message}`);
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
