/**
 * GET  /api/projects/[id]/tasks — 项目任务与费用（分页，时间倒序，每页默认 20）
 * POST /api/projects/[id]/tasks — 批量操作 { action: "retryFailed" | "resumePaused" }
 *   - retryFailed:  重试该项目的全部 FAILED/REJECTED 任务
 *   - resumePaused: 恢复该项目的全部 PAUSED 任务
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { retryGenTask, resumeGenTask } from "@/lib/retry";

const actionSchema = z.object({
  action: z.enum(["retryFailed", "resumePaused"]),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20));

    const where = { projectId: id };
    const [total, tasks] = await Promise.all([
      prisma.genTask.count({ where }),
      prisma.genTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({
      total,
      page,
      pageSize,
      tasks: tasks.map((t) => ({
        id: t.id,
        label: t.label,
        status: t.status,
        cost: t.cost,
        error: t.error,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    });
  } catch (e) {
    console.error("[api/projects/:id/tasks] GET", e);
    return NextResponse.json({ error: "获取任务失败" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const body = actionSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: body.error.issues[0]?.message ?? "参数错误" }, { status: 400 });
    }
    const { action } = body.data;

    if (action === "retryFailed") {
      const failed = await prisma.genTask.findMany({
        where: { projectId: id, status: { in: ["FAILED", "REJECTED"] } },
        select: { id: true, label: true, provider: true },
      });
      let ok = 0;
      const errors: string[] = [];
      for (const t of failed) {
        const r = await retryGenTask(t.id);
        if (r.ok) ok++;
        else if (r.error) errors.push(`${t.id}: ${r.error}`);
      }
      console.log(
        `[api/projects/${id}/tasks] retryFailed: 重试 ${ok}/${failed.length} 个失败任务（仅失败任务，不重跑已完成部分）`
      );
      return NextResponse.json({
        ok: true,
        action,
        total: failed.length,
        succeeded: ok,
        failed: failed.length - ok,
        // 明确告知用户：只重试了哪些失败任务
        retriedTasks: failed.map((t) => ({ id: t.id, label: t.label, provider: t.provider })),
        errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
      });
    }

    // resumePaused
    const paused = await prisma.genTask.findMany({
      where: { projectId: id, status: "PAUSED" },
      select: { id: true, label: true, provider: true },
    });
    let ok = 0;
    const errors: string[] = [];
    for (const t of paused) {
      const r = await resumeGenTask(t.id);
      if (r.ok) ok++;
      else if (r.error) errors.push(`${t.id}: ${r.error}`);
    }
    return NextResponse.json({
      ok: true,
      action,
      total: paused.length,
      succeeded: ok,
      failed: paused.length - ok,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });
  } catch (e) {
    console.error("[api/projects/:id/tasks] POST", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}