/**
 * 流水线全局控制（持久化）
 *
 * 目的：程序（Worker）重启后**默认暂停**，不自动消费 Redis 中遗留的历史任务
 * （失败待重试 / 排队未执行），避免"一启动就重新执行旧任务"。
 * 用户点击「继续执行」后才恢复消费。
 *
 * 存储：PipelineControl 单行表（id 恒为 1），paused 默认 true。
 */
import { prisma } from "@/lib/db";

/** 读取当前暂停状态；无记录时视为暂停（首次启动默认暂停） */
export async function getPipelinePaused(): Promise<boolean> {
  try {
    const row = await prisma.pipelineControl.findUnique({ where: { id: 1 } });
    return row?.paused ?? true;
  } catch {
    // DB 不可用时保守暂停，避免未知状态下自动消费
    return true;
  }
}

/** 写入暂停状态（持久化，重启后保持） */
export async function setPipelinePaused(paused: boolean): Promise<boolean> {
  await prisma.pipelineControl.upsert({
    where: { id: 1 },
    create: { id: 1, paused },
    update: { paused },
  });
  return paused;
}