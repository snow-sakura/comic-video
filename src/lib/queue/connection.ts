/**
 * BullMQ Redis 连接
 * REDIS_URL: redis://localhost:6379
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
}

/** BullMQ 接受的连接参数（ioredis 兼容） */
export function getConnection(): QueueConnection {
  const url = new URL(redisUrl());
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
  };
}
