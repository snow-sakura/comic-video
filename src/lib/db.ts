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
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
