/**
 * GET /api/tasks — 全局任务中心（跨项目）
 * 参数: status=QUEUED|PROCESSING|DONE|FAILED|REJECTED（可省略）& projectId= & page= & pageSize=
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { TaskStatus } from "@/generated/prisma/enums";

const PAGE_SIZE_DEFAULT = 30;
const VALID_STATUS: TaskStatus[] = ["QUEUED", "PROCESSING", "DONE", "FAILED", "REJECTED"];

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(100, Number(url.searchParams.get("pageSize")) || PAGE_SIZE_DEFAULT);

    const validStatus = VALID_STATUS;
    const where: {
      status?: { in: TaskStatus[] };
      projectId?: string;
    } = {
      ...(status && validStatus.includes(status as TaskStatus)
        ? { status: { in: [status as TaskStatus] } }
        : {}),
      ...(projectId ? { projectId } : {}),
    };

    const [total, tasks] = await Promise.all([
      prisma.genTask.count({ where }),
      prisma.genTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { project: { select: { id: true, title: true } } },
      }),
    ]);

    return NextResponse.json({
      total,
      page,
      pageSize,
      tasks: tasks.map((t) => ({
        id: t.id,
        projectId: t.projectId,
        projectTitle: t.project?.title ?? "—",
        label: t.label,
        type: t.type,
        provider: t.provider,
        model: t.model,
        status: t.status,
        cost: t.cost,
        error: t.error,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        durationMs: t.updatedAt.getTime() - t.createdAt.getTime(),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "获取任务失败" }, { status: 500 });
  }
}
