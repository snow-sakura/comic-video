/**
 * BullMQ Redis 连接
 * REDIS_URL: redis://localhost:6379
 *
 * BullMQ 6.x 要求阻塞连接（Worker 的 bclient）必须设置 maxRetriesPerRequest: null，
 * 否则在 Redis 短暂断连后 blocking 命令抛错导致 Worker 崩溃。
 * 此处统一在 getConnection 注入，Queue/Worker 共用，避免每个调用点重复配置。
 */
import { loadEnv } from "@/lib/env";

loadEnv();

export function redisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

export interface QueueConnection {
  host: string;
  port: number;
  password?: string;
  db?: number;
  // ioredis 选项（BullMQ 透传）：
  maxRetriesPerRequest: null; // BullMQ 硬性要求：阻塞命令不重试
  connectTimeout: number; // 首次连接超时（ms），避免无限等待
  keepAlive: number; // TCP keepAlive 心跳，及时检测半开连接
  maxRetries: number; // 断连后重试次数（-1=无限，生产用有限值避免雪崩）
  reconnectOnError: (err: Error) => boolean; // 只对只读错误自动重连
  enableOfflineQueue: boolean; // 断连期间命令排队（false=快速失败）
  retryStrategy?: (times: number) => number | void | Error; // 重连策略（返回延迟 ms）
}

/** BullMQ 接受的连接参数（ioredis 兼容） */
export function getConnection(): QueueConnection {
  const url = new URL(redisUrl());
  
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    // 阻塞连接必须 null（BullMQ 要求），Queue 侧 null 也安全（队列命令无重试上限语义）
    maxRetriesPerRequest: null,
    connectTimeout: 10000, // 10s 首连超时
    keepAlive: 30000, // 30s 心跳
    maxRetries: 10, // 有限重试：断连后最多尝试 10 次，避免无限雪崩
    // READONLY（主从切换）、MOVED/ASK（集群重定向）自动重连，其余错误抛出
    reconnectOnError: (err: Error) => {
      const msg = err.message;
      return msg.includes("READONLY") || msg.includes("MOVED") || msg.includes("ASK");
    },
    // 断连期间入队命令直接失败（触发 enqueueGenTask 的 catch → 标记 FAILED），
    // 避免命令在 offline queue 无限堆积占用内存
    enableOfflineQueue: false,
  };
}

/**
 * Worker 专用连接：断连期间命令排队等待重连（enableOfflineQueue: true）+ 指数退避重连。
 *
 * 为什么与 Queue 不同：Worker 持阻塞命令（BRPOPLPUSH）且任务可能执行数分钟
 * （视频轮询最长 20 分钟），断连期间若快速失败，处理中的 job 会抛
 * "Stream isn't writeable" 并被错误重试/标记失败（.worker.log 曾出现大量该错误）。
 * 排队 + 重连可在 Redis 短暂重启后无缝恢复；Worker 侧排队的命令量级很小（仅处理中 job）。
 */
export function getWorkerConnection(): QueueConnection {
  return {
    ...getConnection(),
    enableOfflineQueue: true,
    retryStrategy: (times: number) => Math.min(times * 1000, 15000), // 1s → 2s → … → 15s 上限
  };
}
