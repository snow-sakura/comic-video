/**
 * BullMQ Worker 处理器 — 与 GenTask 表联动
 * 每个 handler 从 job.data 取 { taskId, ...payload }，
 * 执行后将结果写入 GenTask（DONE/FAILED），视频类任务内部轮询平台状态。
 */
import type { Job, Worker } from "bullmq";
import { Worker as BullWorker } from "bullmq";
import { prisma } from "@/lib/db";
import { getWorkerConnection } from "@/lib/queue/connection";
import { QUEUE_DEFS, type QueueName, pauseStuckTasks, drainQueues } from "@/lib/queue/queues";
import type { GenTask } from "@/generated/prisma/client";
import type { TaskHandle, TTSSubtitle } from "@/lib/providers/types";
import { estimateSubtitles, probeAudioDuration } from "@/lib/tts/subtitles";
import { recordCost } from "@/lib/cost";
import { getImage, getStructLLM, getTTS, getVideo } from "@/lib/providers/registry";
import { runExtractCharacters, runGenerateOutline, runGenerateEpisode } from "@/lib/agents";
import { runStoryboardEpisode } from "@/lib/storyboard";
import { composeEpisode } from "@/lib/compose";
import { getPipelinePaused } from "@/lib/pipeline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ========== GenTask 状态联动 ==========

async function markProcessing(taskId: string): Promise<void> {
  await prisma.genTask.update({ where: { id: taskId }, data: { status: "PROCESSING" } }).catch((e) => {
    console.error("[worker] markProcessing failed:", e);
  });
}

async function markDone(taskId: string): Promise<void> {
  await prisma.genTask
    .update({ where: { id: taskId }, data: { status: "DONE", error: null } })
    .catch((e) => {
      console.warn("[worker] markDone failed:", e);
    });
}

async function markFailed(taskId: string, error: string): Promise<void> {
  await prisma.genTask
    .update({ where: { id: taskId }, data: { status: "FAILED", error } })
    .catch((e) => {
      console.error("[worker] markFailed failed:", e);
    });
}

/**
 * 任务执行前的安全检查：若 GenTask 已被标记为 PAUSED（程序重启时由 pauseStuckTasks 标记），
 * 则跳过执行，避免"一启动就自动跑旧任务"。
 *
 * 场景：Worker 重启 → pauseStuckTasks 将 PROCESSING/QUEUED → PAUSED → drainQueues 清空 BullMQ。
 * 但 BullMQ 的 stalled job 恢复机制仍可能让旧 job 被重新拾取，此处作为最后一道防线。
 *
 * @returns true 表示任务应跳过（已被暂停或已删除）；false 表示继续执行
 */
async function shouldSkipTask(taskId: string): Promise<boolean> {
  try {
    const task = await prisma.genTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!task) {
      console.log(`[worker] 任务 ${taskId} 不存在，跳过`);
      return true;
    }
    if (task.status === "PAUSED") {
      console.log(`[worker] 任务 ${taskId} 处于 PAUSED 状态，跳过（需用户手动继续执行）`);
      return true;
    }
    // DONE/FAILED 的任务也不重复执行
    if (task.status === "DONE" || task.status === "FAILED" || task.status === "REJECTED") {
      console.log(`[worker] 任务 ${taskId} 已是 ${task.status} 状态，跳过`);
      return true;
    }
    return false;
  } catch (e) {
    // DB 不可用时保守放行（避免误判阻塞正常任务）
    console.warn(`[worker] shouldSkipTask 查询失败 taskId=${taskId}:`, e);
    return false;
  }
}

// ========== 各队列处理器 ==========

type Handler = (job: Job) => Promise<Record<string, unknown>>;

/** script: 剧本工坊 LLM 任务（payload: { agent: extract|outline|script|plain, projectId?, episodeNumber?, input? }） */
const scriptHandler: Handler = async (job) => {
  const { taskId, agent, projectId, episodeNumber, episodeCount, input } = job.data as {
    taskId: string;
    agent: string;
    projectId?: string;
    episodeNumber?: number;
    episodeCount?: number;
    input?: string;
  };
  if (await shouldSkipTask(taskId)) return {};
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
      const r = await runGenerateOutline(projectId, episodeCount);
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
      .catch((e) => { console.warn("[worker] findUnique project failed:", e); return null; });
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
  const { taskId, prompt, size, refImages, count, aspectRatio, negativePrompt, refType, refId, shotId, category } = job.data;
  const shotIdStr = shotId ? String(shotId) : undefined;
  if (await shouldSkipTask(taskId)) return {};
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
      category: (category as never) ?? undefined,
    });
    if (handle.status === "failed") throw new Error(handle.error ?? "图像生成失败");
    const imagePaths = handle.result?.imagePaths ?? [];

    // 资产生成 → 回写资源表（存相对路径，供后续作为参考图）
    if (refId && imagePaths.length > 0) {
      if (refType === "character") {
        await prisma.character
          .update({ where: { id: refId }, data: { refImageIds: { push: imagePaths } } })
          .catch((e) => { console.warn("[worker] update character refImageIds failed:", e); });
      } else if (refType === "scene") {
        await prisma.scene
          .update({ where: { id: refId }, data: { refImageIds: { push: imagePaths } } })
          .catch((e) => { console.warn("[worker] update scene refImageIds failed:", e); });
      } else if (refType === "asset") {
        await prisma.asset
          .update({ where: { id: refId }, data: { imageIds: { push: imagePaths } } })
          .catch((e) => { console.warn("[worker] update asset imageIds failed:", e); });
      }
    }

    // 分镜出图 → 回写 Shot
    if (shotIdStr && imagePaths.length > 0) {
      await prisma.shot
        .update({
          where: { id: shotIdStr },
          data: { imagePath: imagePaths[0], status: "IMAGE_DONE" },
        })
        .catch((e) => { console.warn("[worker] update shot IMAGE_DONE failed:", e); });
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
        .catch((e2) => { console.warn("[worker] update shot IMAGE_FAILED failed:", e2); });
    }
    throw e;
  }
};

/** video: 视频任务（payload: { shotId, imagePath, prompt, refImages, duration, tailImagePath }）
 *  可灵为异步平台任务：submit → 保存 providerTaskId → 轮询 getTask 直至完成
 *  若任务已有 providerTaskId（重启恢复场景），直接进入轮询而非重新提交
 *  shotId: 分镜视频生成时回写到 Shot 表（videoPath + VIDEO_DONE） */
const videoHandler: Handler = async (job) => {
  const { taskId, imagePath, prompt, refImages, duration, tailImagePath } = job.data;
  if (await shouldSkipTask(taskId)) return {};
  await markProcessing(taskId);
  const video = await getVideo();

  // 恢复场景：如果任务已有 providerTaskId，直接跳到轮询
  const existingTask = await prisma.genTask.findUnique({
    where: { id: taskId },
    select: { providerTaskId: true },
  });
  let providerTaskId = existingTask?.providerTaskId ?? undefined;

  // 1. 提交（仅在没有已有 providerTaskId 时）
  if (!providerTaskId) {
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
    const newTaskId = submitHandle.providerTaskId;
    if (!newTaskId) throw new Error("视频任务缺少 providerTaskId");

    // 保存平台任务 ID（供 UI 展示/恢复）
    await prisma.genTask
      .update({ where: { id: taskId }, data: { providerTaskId: newTaskId } })
      .catch((e) => { console.warn("[worker] update providerTaskId failed:", e); });
    providerTaskId = newTaskId;
  } else {
    console.log(`[video] 恢复轮询 providerTaskId=${providerTaskId}`);
  }

  // 2. 轮询（最长 ~20 分钟）
  const deadline = Date.now() + 20 * 60 * 1000;
  let handle: TaskHandle<{ videoPath: string }> = { taskId, status: "processing" };
  while (Date.now() < deadline) {
    // 轮询间隙检查流水线是否已被暂停（用户点击暂停时应停止轮询）
    if (await getPipelinePaused()) {
      // 标记为 PAUSED 并退出，保留 providerTaskId 供恢复
      await prisma.genTask
        .update({ where: { id: taskId }, data: { status: "PAUSED", error: "轮询期间流水线被暂停" } })
        .catch((e) => { console.warn("[worker] pause during polling failed:", e); });
      console.log(`[video] 轮询期间流水线被暂停，任务 ${taskId} 已暂停（providerTaskId=${providerTaskId}）`);
      return { paused: true, providerTaskId };
    }
    await sleep(10000);
    handle = await video.getTask(providerTaskId!);
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
    // Redis 断连期间 updateProgress 可能失败，不影响业务（轮询继续）
    await job.updateProgress({ status: "processing" }).catch(() => {});
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
      .catch((e) => { console.warn("[worker] writeBackShot video failed:", e); });
  } else {
    await prisma.shot
      .update({
        where: { id: shotId },
        data: path ? { voicePath: path, status: "VOICE_DONE" } : { status: "VOICE_FAILED" },
      })
      .catch((e) => { console.warn("[worker] writeBackShot voice failed:", e); });
  }
}

/** audio: TTS 任务（payload: { shotId, text, voiceId, emotion, rate, sampleRate }）
 *  shotId: 分镜配音时回写到 Shot 表（voicePath/subtitlePath + VOICE_DONE） */
const audioHandler: Handler = async (job) => {
  const { taskId, shotId, text, voiceId, emotion, rate, sampleRate } = job.data;
  if (await shouldSkipTask(taskId)) return {};
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
    } catch (e) {
      console.warn("[worker] probeAudioDuration for subtitles failed:", e);
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
        .catch((e) => { console.warn("[worker] update shot VOICE_DONE failed:", e); });
    }
  // 费用估算：按真实音频时长（分钟单价）
  if (result.audioPath) {
    try {
      const dur = await probeAudioDuration(result.audioPath);
      await recordCost(taskId, { kind: "audio", durationSec: dur });
    } catch (e) {
      console.warn("[worker] probeAudioDuration for cost failed:", e);
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
  if (await shouldSkipTask(taskId)) return {};
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

/** 单个 worker 的暂停/恢复（不等待，异常静默：暂停失败不应阻塞 API） */
async function applyPauseState(worker: Worker, paused: boolean): Promise<void> {
  try {
    if (paused) await worker.pause();
    else await worker.resume();
  } catch (e) {
    console.error(`[queue:${worker.name}] ${paused ? "pause" : "resume"} 失败: ${e instanceof Error ? e.message : e}`);
  }
}

/** 按持久化状态暂停/恢复全部已启动 worker（API「暂停/继续执行」调用） */
export async function setWorkersPaused(paused: boolean): Promise<void> {
  if (paused) {
    // 暂停：先暂停 Worker 再标记 DB
    await Promise.all([...workers.values()].map((w) => applyPauseState(w, true)));
    await prisma.genTask
      .updateMany({
        where: { status: "QUEUED" },
        data: { status: "PAUSED", error: "流水线暂停，需手动继续执行" },
      })
      .catch((e) => { console.warn("[worker] updateMany QUEUED→PAUSED failed:", e); });
  } else {
    // 恢复：对每个 Worker 调用 resume 或 run（autorun=false 的 Worker 需要 run 启动）
    await Promise.all([...workers.values()].map(async (w) => {
      try {
        if (w.isRunning()) {
          await w.resume();
        } else {
          // autorun=false 创建的 Worker，首次恢复需调用 run()
          w.run();
        }
      } catch (e) {
        console.error(`[queue:${w.name}] resume/run 失败: ${e instanceof Error ? e.message : e}`);
      }
    }));
  }
  console.log(`[queue] 流水线${paused ? "已暂停" : "已继续"}（同步 ${workers.size} 个 worker）`);
}

/** 启动指定队列的 worker（生产进程调用）
 *  @param initialPaused 启动时是否暂停（由 startAllWorkers 根据流水线状态决定） */
export function startWorker(name: QueueName, initialPaused = false): Worker {
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
      // Worker 专用连接：断连时命令排队 + 自动重连，避免 Redis 短暂重启
      // 时处理中任务抛 "Stream isn't writeable" 被错误标记失败
      connection: getWorkerConnection(),
      concurrency: QUEUE_DEFS[name].concurrency,
      // 如果流水线暂停，Worker 以 autorun=false 创建，绝不自动消费任务
      autorun: !initialPaused,
      stalledInterval: 30000,
      maxStalledCount: 1,
    }
  );
  worker.on("failed", (job, err) => {
    console.error(`[queue:${name}] job ${job?.id} failed: ${err.message}`);
    const attempts = job?.opts.attempts ?? 3;
    if (!job || job.attemptsMade < attempts) return;
    const { taskId } = (job?.data ?? {}) as { taskId?: string };
    if (taskId) {
      prisma.genTask
        .updateMany({
          where: { id: taskId, status: { in: ["QUEUED", "PROCESSING"] } },
          data: { status: "FAILED", error: err.message },
        })
        .catch((e) => { console.warn("[worker] updateMany GenTask→FAILED failed:", e); });
    }
    const { shotId } = (job?.data ?? {}) as { shotId?: string };
    if (shotId && name === "audio") {
      prisma.shot
        .updateMany({
          where: { id: String(shotId), status: "VOICE_GENERATING" },
          data: { status: "VOICE_FAILED", error: err.message },
        })
        .catch((e) => { console.warn("[worker] updateMany Shot→VOICE_FAILED failed:", e); });
    } else if (shotId && name === "video") {
      prisma.shot
        .updateMany({
          where: { id: String(shotId), status: "VIDEO_GENERATING" },
          data: { status: "VIDEO_FAILED", error: err.message },
        })
        .catch((e) => { console.warn("[worker] updateMany Shot→VIDEO_FAILED failed:", e); });
    }
  });
  // Redis 断连等瞬时错误限频输出，避免 .worker.log 被刷屏（同一错误 10s 内只打一次）
  let lastErrorLog = 0;
  worker.on("error", (err) => {
    const now = Date.now();
    if (now - lastErrorLog < 10_000) return;
    lastErrorLog = now;
    console.error(`[queue:${name}] worker error: ${err.message}`);
  });
  workers.set(name, worker);
  if (initialPaused) {
    console.log(`[queue:${name}] 流水线暂停中（Worker 已创建但不消费任务）`);
  }
  return worker;
}

export async function startAllWorkers(): Promise<Worker[]> {
  // 1. 先完成 DB 清理：将 PROCESSING/QUEUED → PAUSED
  await pauseStuckTasks();
  // 2. 清空 BullMQ 队列残留任务（防止 stalled job 被自动重投）
  await drainQueues();
  // 3. 读取持久化流水线状态
  const pipelinePaused = await getPipelinePaused();
  // 4. 创建 Worker（如流水线暂停则以 autorun=false 创建，确保不消费任务）
  const ws = (Object.keys(QUEUE_DEFS) as QueueName[]).map((name) => startWorker(name, pipelinePaused));
  if (pipelinePaused) {
    console.log("[queue] 流水线暂停中，Worker 已创建但不会自动消费任务");
  }
  return ws;
}

export async function closeWorkers(): Promise<void> {
  await Promise.all([...workers.values()].map((w) => w.close()));
  workers.clear();
}

export type { GenTask };
