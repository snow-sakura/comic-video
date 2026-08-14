/**
 * 任务重试/恢复：从 GenTask 元数据 + 业务表重建 payload 重新入队。
 * 支持 script-agent(LLM) / seedream(图: shot|character|scene|asset) / kling(视频) / cosyvoice(配音) / ffmpeg(合成)。
 *
 * 核心原则：GenTask.input 只是费用估算快照（prompt 截断、字段残缺），
 * 入队 payload 必须从业务表（Shot/Character/Scene/Asset/Episode）实时重建，否则任务会走错误分支。
 *
 * 重试策略：
 * - 指数退避：delay = baseDelay × 2^attempt（base 1s，上限 60s）
 * - HTTP 4xx 不重试（客户端错误），5xx 指数退避重试
 * - 最大重试次数默认 3 次
 */
import { prisma } from "@/lib/db";
import { enqueueGenTask, type QueueName } from "@/lib/queue/queues";
import { buildMotionPrompt } from "@/lib/compose/prompts";
import { characterDesignPrompt, sceneDesignPrompt, propDesignPrompt, styleAnchor } from "@/lib/assets/prompts";
import { getPipelinePaused, setPipelinePaused } from "@/lib/pipeline";
import type { GenTask } from "@/generated/prisma/client";

// ========== 重试策略配置 ==========

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s
const MAX_DELAY_MS = 60000; // 60s

/**
 * 计算指数退避延迟（毫秒）
 * delay = baseDelay × 2^attempt，上限 MAX_DELAY_MS
 */
export function getBackoffDelay(attempt: number, baseDelayMs = BASE_DELAY_MS, maxDelayMs = MAX_DELAY_MS): number {
  const delay = baseDelayMs * Math.pow(2, attempt);
  return Math.min(delay, maxDelayMs);
}

/**
 * 判断错误是否为 HTTP 4xx（客户端错误，不应重试）
 * 支持标准 Error.message 中包含状态码，以及 { status, statusCode } 对象
 */
export function is4xxError(error: unknown): boolean {
  if (!error) return false;
  // 对象形式 { status / statusCode }
  if (typeof error === "object") {
    const status = (error as { status?: number; statusCode?: number }).status
      ?? (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) return true;
    // 检查 message
    const msg = (error as Error).message ?? "";
    if (/\b4\d{2}\b/.test(msg)) return true;
  }
  // 字符串 / Error
  const msg = error instanceof Error ? error.message : String(error);
  return /\b4\d{2}\b/.test(msg);
}

/**
 * 带指数退避的重试执行器
 * 4xx 错误立即拒绝（不重试），5xx/其他错误按指数退避重试
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    label?: string;
  } = {}
): Promise<T> {
  const { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = BASE_DELAY_MS, maxDelayMs = MAX_DELAY_MS, label = "" } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // 4xx 不重试
      if (is4xxError(e)) {
        console.warn(`[retry]${label ? ` ${label}` : ""} 4xx error, will not retry:`, e instanceof Error ? e.message : e);
        throw e;
      }
      // 最后一次不再等待
      if (attempt >= maxRetries) {
        console.error(`[retry]${label ? ` ${label}` : ""} exhausted ${maxRetries} retries`);
        throw e;
      }
      const delay = getBackoffDelay(attempt, baseDelayMs, maxDelayMs);
      console.warn(`[retry]${label ? ` ${label}` : ""} attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ========== 重试/恢复结果 ==========

export interface RetryResult {
  ok: boolean;
  error?: string;
}

// ========== payload 重建（核心） ==========

export interface RebuiltPayload {
  queueName: QueueName;
  payload: Record<string, unknown>;
}

export type RebuildResult = { ok: true; data: RebuiltPayload } | { ok: false; error: string };

/** 重置关联镜头状态（幂等，失败仅告警） */
async function resetShotStatus(shotId: string | null | undefined, status: string): Promise<void> {
  if (!shotId) return;
  try {
    await prisma.shot.update({ where: { id: shotId }, data: { status } as never });
  } catch (e) {
    console.warn("[rebuild] reset shot status failed:", e);
  }
}

/**
 * 从 GenTask 元数据 + 业务表重建入队 payload（resume/retry 共用）。
 * 绝不直接使用 task.input（费用快照，字段残缺）。
 */
export async function rebuildGenTaskPayload(task: GenTask): Promise<RebuildResult> {
  const input = (task.input ?? {}) as { episodeNumber?: number; angle?: string; kind?: string };
  const episodeNumber = Number(input.episodeNumber) || undefined;

  switch (task.provider) {
    case "script-agent": {
      // model 字段即 stage（characters/outline/script/storyboard）
      return {
        ok: true,
        data: {
          queueName: "script",
          payload: { agent: task.model, projectId: task.projectId, episodeNumber },
        },
      };
    }

    case "seedream": {
      const refType = task.refType ?? "shot";
      const anchor = styleAnchor(
        task.projectId
          ? ((await prisma.project.findUnique({ where: { id: task.projectId }, select: { style: true } }))?.style as never)
          : null
      );

      // 分镜出图（storyboard）
      if (refType === "shot") {
        const shot = task.refId ? await prisma.shot.findUnique({ where: { id: task.refId } }) : null;
        if (!shot) return { ok: false, error: "关联镜头不存在，请在分镜车间重新出图" };
        if (!shot.finalPrompt) return { ok: false, error: "镜头缺少 finalPrompt，请在分镜车间重新出图" };
        await resetShotStatus(shot.id, "IMAGE_GENERATING");
        return {
          ok: true,
          data: {
            queueName: "image",
            payload: {
              prompt: shot.finalPrompt,
              refImages: shot.refImages,
              count: 1,
              aspectRatio: "16:9",
              shotId: shot.id,
            },
          },
        };
      }

      // 角色定妆照（assets）
      if (refType === "character") {
        const character = task.refId ? await prisma.character.findUnique({ where: { id: task.refId } }) : null;
        if (!character) return { ok: false, error: "关联角色不存在，请重新生成定妆照" };
        const c = character.appearance as never as {
          hair?: string; costume?: string; facialMarkers?: string; body?: string; style?: string;
        };
        // 已锁定 → 只补一张四分之三侧面（与创建逻辑一致）
        const locked = character.refImageIds.length > 0 && character.status === "APPROVED";
        const angle = (locked || !["front", "three-quarter", "full"].includes(input.angle ?? ""))
          ? "three-quarter"
          : (input.angle as "front" | "three-quarter" | "full");
        const prompt = await characterDesignPrompt(
          {
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
          },
          anchor,
          angle,
          task.projectId
        );
        return {
          ok: true,
          data: {
            queueName: "image",
            payload: {
              prompt,
              refImages: locked ? character.refImageIds : [],
              count: 1,
              aspectRatio: "3:4",
              refType: "character",
              refId: character.id,
              category: "characters",
            },
          },
        };
      }

      // 场景空镜（assets）
      if (refType === "scene") {
        const scene = task.refId ? await prisma.scene.findUnique({ where: { id: task.refId } }) : null;
        if (!scene) return { ok: false, error: "关联场景不存在，请重新生成空镜" };
        const prompt = await sceneDesignPrompt(
          { name: scene.name, description: scene.description, mood: scene.mood, refImageIds: scene.refImageIds },
          anchor,
          task.projectId
        );
        return {
          ok: true,
          data: {
            queueName: "image",
            payload: {
              prompt,
              refImages: scene.refImageIds,
              count: 1,
              aspectRatio: "16:9",
              refType: "scene",
              refId: scene.id,
              category: "scenes",
            },
          },
        };
      }

      // 道具（assets）
      if (refType === "asset") {
        const asset = task.refId ? await prisma.asset.findUnique({ where: { id: task.refId } }) : null;
        if (!asset) return { ok: false, error: "关联道具不存在，请重新生成" };
        const desc = String(((asset.meta as never as { desc?: string }) ?? {})?.desc ?? "");
        const prompt = await propDesignPrompt(asset.name, desc, anchor, task.projectId);
        return {
          ok: true,
          data: {
            queueName: "image",
            payload: {
              prompt,
              refImages: asset.imageIds,
              count: 1,
              aspectRatio: "16:9",
              refType: "asset",
              refId: asset.id,
              category: "props",
            },
          },
        };
      }

      return { ok: false, error: `不支持的 seedream refType: ${refType}` };
    }

    case "kling":
    case "agnes": {
      const shot = task.refId ? await prisma.shot.findUnique({ where: { id: task.refId } }) : null;
      if (!shot) return { ok: false, error: "关联镜头不存在，请先在分镜车间出图" };
      if (!shot.imagePath) return { ok: false, error: "镜头没有分镜图，请先出图" };
      await resetShotStatus(shot.id, "VIDEO_GENERATING");
      return {
        ok: true,
        data: {
          queueName: "video",
          payload: {
            shotId: shot.id,
            imagePath: shot.imagePath,
            prompt: await buildMotionPrompt(shot, task.projectId),
            duration: 5,
          },
        },
      };
    }

    case "cosyvoice": {
      // 历史遗留的整集批量配音（input.batch=true 且无 refId）：worker 仅支持逐镜头 TTS，无法重放
      if ((input as { batch?: boolean }).batch && !task.refId) {
        return { ok: false, error: "批量配音为旧版格式，无法直接恢复，请按镜头重新配音" };
      }
      const shot = task.refId ? await prisma.shot.findUnique({ where: { id: task.refId } }) : null;
      if (!shot) return { ok: false, error: "关联镜头不存在" };
      if (!shot.dialog) return { ok: false, error: "镜头没有台词，无法配音" };
      const voiceByChar = await getVoiceMap(shot.episodeId);
      await resetShotStatus(shot.id, "VOICE_GENERATING");
      return {
        ok: true,
        data: {
          queueName: "audio",
          payload: {
            shotId: shot.id,
            text: shot.dialog,
            voiceId: shot.dialogChar ? voiceByChar.get(shot.dialogChar) ?? undefined : undefined,
            emotion: shot.dialogEmotion ?? undefined,
          },
        },
      };
    }

    case "ffmpeg": {
      const episodeId = task.refId ?? undefined;
      if (!episodeId) return { ok: false, error: "缺少剧集信息，请在视频合成厂重新合成" };
      return {
        ok: true,
        data: {
          queueName: "compose",
          payload: { episodeId, bgmMood: undefined },
        },
      };
    }

    default:
      return { ok: false, error: `不支持的 provider: ${task.provider}` };
  }
}

// ========== 手动重试（FAILED / REJECTED） ==========

/**
 * 手动重试任务：从 GenTask 元数据 + 业务表重建 payload 重新入队。
 * 4xx 错误标记为 REJECTED 不再重试，其他错误正常重试。
 */
export async function retryGenTask(taskId: string): Promise<RetryResult> {
  const task = await prisma.genTask.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false, error: "任务不存在" };
  if (!["FAILED", "REJECTED"].includes(task.status)) {
    return { ok: false, error: "仅失败/拒绝状态的任务可重试" };
  }

  // 4xx 客户端错误：标记为 REJECTED，不自动重试
  if (task.error && is4xxError(task.error)) {
    await prisma.genTask.update({ where: { id: taskId }, data: { status: "REJECTED" } }).catch((e) => {
      console.warn("[retry] mark REJECTED failed:", e);
    });
    return { ok: false, error: `4xx 客户端错误，不可自动重试: ${task.error}` };
  }

  const rebuilt = await rebuildGenTaskPayload(task);
  if (!rebuilt.ok) return { ok: false, error: rebuilt.error };

  // 重试必须用新 jobId（BullMQ 相同 jobId 已完成任务不会重复执行）
  const retryJobId = `${taskId}_retry_${Date.now()}`;

  await prisma.genTask.update({ where: { id: taskId }, data: { status: "QUEUED", error: null } });
  await enqueueGenTask(rebuilt.data.queueName, {
    taskId,
    jobId: retryJobId,
    payload: rebuilt.data.payload,
  });
  return { ok: true };
}

// ========== 恢复暂停任务（PAUSED） ==========

/**
 * 恢复暂停的任务（PAUSED → QUEUED 并重新入队）。
 * 与 retry 相同地从业务表重建完整 payload，避免 input 快照残缺导致执行错分支。
 * 若流水线全局暂停，自动恢复（worker 进程轮询 PipelineControl 后自行恢复消费）。
 */
export async function resumeGenTask(taskId: string): Promise<RetryResult> {
  const task = await prisma.genTask.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false, error: "任务不存在" };
  if (task.status !== "PAUSED") {
    return { ok: false, error: "仅暂停状态的任务可恢复" };
  }

  const rebuilt = await rebuildGenTaskPayload(task);
  if (!rebuilt.ok) return { ok: false, error: rebuilt.error };

  if (await getPipelinePaused()) {
    await setPipelinePaused(false);
  }

  const resumeJobId = `${taskId}_resume_${Date.now()}`;
  await prisma.genTask.update({ where: { id: taskId }, data: { status: "QUEUED", error: null } });
  await enqueueGenTask(rebuilt.data.queueName, {
    taskId,
    jobId: resumeJobId,
    payload: rebuilt.data.payload,
  });
  return { ok: true };
}

/** 该集角色 → 声音 ID 映射（与 compose 路由一致） */
async function getVoiceMap(episodeId: string): Promise<Map<string, string>> {
  const episode = await prisma.episode.findUnique({ where: { id: episodeId } });
  if (!episode) return new Map();
  const chars = await prisma.character.findMany({ where: { projectId: episode.projectId } });
  return new Map(chars.filter((c) => c.voiceId).map((c) => [c.name, c.voiceId as string]));
}
