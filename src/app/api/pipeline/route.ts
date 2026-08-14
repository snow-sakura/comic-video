/**
 * GET  /api/pipeline — 查询流水线全局状态 { paused }
 * POST /api/pipeline — { action: "pause" | "resume" } 暂停/继续执行
 *
 * 暂停：持久化到 PipelineControl（重启后保持），并同步暂停全部 Worker
 *       （已处理中的任务会跑完，新任务不再消费）。
 * 继续：置 paused=false 并恢复 Worker，Redis 中等待中的任务开始执行。
 */
import { NextResponse } from "next/server";
import { getPipelinePaused, setPipelinePaused } from "@/lib/pipeline";
import { setWorkersPaused } from "@/lib/queue/workers";
import { prisma } from "@/lib/db";

export async function GET(): Promise<NextResponse> {
  try {
    const [paused, queued] = await Promise.all([
      getPipelinePaused(),
      prisma.genTask.count({ where: { status: "QUEUED" } }),
    ]);
    return NextResponse.json({ paused, queued });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "查询流水线状态失败" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "pause" && body.action !== "resume") {
      return NextResponse.json({ error: "action 必须为 pause 或 resume" }, { status: 400 });
    }
    const paused = body.action === "pause";
    // 先持久化再同步 worker：DB 写入失败则不改变运行时状态
    await setPipelinePaused(paused);
    await setWorkersPaused(paused);
    const queued = await prisma.genTask.count({ where: { status: "QUEUED" } });
    return NextResponse.json({ paused, queued });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "操作失败" },
      { status: 500 },
    );
  }
}