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

export const QUEUE_NAMES = {
  script: "script",
  image: "image",
  video: "video",
  audio: "audio",
  compose: "compose",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUE_DEFS: Record<QueueName, { name: string; concurrency: number }> = {
  script: { name: QUEUE_NAMES.script, concurrency: 1 },
  image: { name: QUEUE_NAMES.image, concurrency: 2 },
  video: { name: QUEUE_NAMES.video, concurrency: 2 },
  audio: { name: QUEUE_NAMES.audio, concurrency: 2 },
  compose: { name: QUEUE_NAMES.compose, concurrency: 1 },
};

// ========== Queue 实例（懒创建 + 缓存） ==========

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  if (!queues.has(name)) {
    queues.set(
      name,
      new Queue(QUEUE_DEFS[name].name, {
        connection: getConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      })
    );
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

/** 入队并同步 GenTask 状态（QUEUED → RUNNING） */
export async function enqueueGenTask(
  queueName: QueueName,
  { taskId, payload, delay = 0, jobId }: EnqueueGenTaskInput
): Promise<string> {
  const queue = getQueue(queueName);
  // 默认 jobId = taskId（幂等：同任务不重复入队）；
  // 重试场景必须传新 jobId，否则 BullMQ 返回已完成旧 job 而不重新执行
  const job = await queue.add(
    `${taskId}`,
    { taskId, ...payload },
    { jobId: jobId ?? taskId, delay, removeOnFail: false }
  );
  return job.id ?? taskId;
}

/** 关闭所有队列（进程退出/测试清理） */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
