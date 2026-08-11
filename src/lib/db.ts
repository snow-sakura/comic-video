import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { loadEnv } from "@/lib/env";

// 确保 Worker 进程也能读到 env
loadEnv();

// Prisma 7 需要 driver adapter（datasource url 已从 schema 移除）。
// 显式创建 pg.Pool 并传入 adapter：避免 Turbopack 打包环境下
// adapter 内部 import 的 pg 与外部 pg 双实例导致的认证失败。
// 全局单例，避免 dev 模式热重载时连接泄漏。

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,                      // 最大连接数（默认 10 不够：8 Worker 并发 + API 请求）
    idleTimeoutMillis: 30000,     // 空闲连接 30s 后回收
    connectionTimeoutMillis: 5000, // 连接超时 5s（避免无限等待）
  });
  // 连接池级错误（如数据库重启后 idle 连接失效）必须监听，否则进程崩溃
  pool.on("error", (err) => {
    console.error(`[db] 连接池错误: ${err.message}`);
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
