/**
 * 队列定义与入队辅助
 * 五条队列对应四步流水线 + 合成：
 *   script  → 剧本工坊（LLM 长任务）
 *   image   → 分镜/资产出图（Seedream）
 *   video   → 分镜转视频（可灵，异步提交+轮询）
 *   audio   → TTS/音乐/音效
 *   compose → 最终合成导出（ffmpeg）
 */
import { Queue } from "bullmq";
import { getConnection } from "@/lib/queue/connection";
import { prisma } from "@/lib/db";

export const QUEUE_NAMES = {
  script: "script",
  image: "image",
  video: "video",
  audio: "audio",
  compose: "compose",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * 队列定义
 * concurrency（Worker 并发数）可通过环境变量动态覆盖，以适配不同资源的服务器：
 *   WORKER_CONCURRENCY_SCRIPT
 *   WORKER_CONCURRENCY_IMAGE
 *   WORKER_CONCURRENCY_VIDEO
 *   WORKER_CONCURRENCY_AUDIO
 *   WORKER_CONCURRENCY_COMPOSE
 *
 * 调优建议：
 * - image/video/audio: I/O 密集型（调用外部 API），可适当调高（如 4-8），但需注意 AI 平台的 QPS/并发限流。
 * - compose: CPU 密集型（ffmpeg 合成），建议不超过服务器 CPU 核心数，默认 1 最安全。
 * - script: 长任务（LLM），通常 1-2 即可。
 */
const getConcurrency = (queueName: string, defaultVal: number): number => {
  const envKey = `WORKER_CONCURRENCY_${queueName.toUpperCase()}`;
  const envVal = Number(process.env[envKey]);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : defaultVal;
};

export const QUEUE_DEFS: Record<QueueName, { name: string; concurrency: number }> = {
  script: { name: QUEUE_NAMES.script, concurrency: getConcurrency("script", 1) },
  image: { name: QUEUE_NAMES.image, concurrency: getConcurrency("image", 2) },
  video: { name: QUEUE_NAMES.video, concurrency: getConcurrency("video", 2) },
  audio: { name: QUEUE_NAMES.audio, concurrency: getConcurrency("audio", 2) },
  compose: { name: QUEUE_NAMES.compose, concurrency: getConcurrency("compose", 1) },
};

// ========== Queue 实例（懒创建 + 缓存） ==========

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  if (!queues.has(name)) {
    const queue = new Queue(QUEUE_DEFS[name].name, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
    // Queue 级错误（如 Redis 断连）必须监听，否则 EventEmitter 无 listener
    // 会触发 uncaughtException 导致进程崩溃
    queue.on("error", (err) => {
      console.error(`[queue:${name}] queue error: ${err.message}`);
    });
    queues.set(name, queue);
  }
  return queues.get(name)!;
}

// ========== 入队辅助 ==========

export interface EnqueueGenTaskInput {
  /** GenTask.id（联动数据库任务记录） */
  taskId: string;
  /** 传递给处理器的业务负载 */
  payload: Record<string, unknown>;
  /** 延迟执行（ms） */
  delay?: number;
  /** 显式 jobId（重试时必传新值，否则 BullMQ 返回旧 job 不执行） */
  jobId?: string;
  /** 入队时立即标记 GenTask 为 RUNNING（默认 true） */
  markRunning?: boolean;
}

/** 入队并同步 GenTask 状态（QUEUED → RUNNING）
 *  入队失败（如 Redis 不可用）时标记任务 FAILED 并抛错，避免任务卡在 QUEUED */
export async function enqueueGenTask(
  queueName: QueueName,
  { taskId, payload, delay = 0, jobId }: EnqueueGenTaskInput
): Promise<string> {
  const queue = getQueue(queueName);
  // 默认 jobId = taskId（幂等：同任务不重复入队）；
  // 重试场景必须传新 jobId，否则 BullMQ 返回已完成旧 job 而不重新执行
  try {
    const job = await queue.add(
      `${taskId}`,
      { taskId, ...payload },
      { jobId: jobId ?? taskId, delay, removeOnFail: false }
    );
    return job.id ?? taskId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[enqueue] 入队失败 taskId=${taskId} queue=${queueName}: ${msg}`);
    // 标记任务失败，避免 QUEUED 僵死；DB 不可用时静默
    await prisma.genTask
      .update({ where: { id: taskId }, data: { status: "FAILED", error: `入队失败: ${msg}` } })
      .catch(() => {});
    throw new Error(`入队失败: ${msg}`);
  }
}

/** 关闭所有队列（进程退出/测试清理） */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
