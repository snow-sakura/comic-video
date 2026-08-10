/**
 * POST /api/projects — 创建项目
 * GET  /api/projects — 项目列表
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";

const createSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(100),
});

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = createSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: body.error.issues[0]?.message ?? "参数错误" }, { status: 400 });
    }
    const project = await prisma.project.create({
      data: { title: body.data.title },
    });
    return NextResponse.json(project, { status: 201 });
  } catch (e) {
    console.error("[api/projects] POST", e);
    return NextResponse.json({ error: "创建项目失败" }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { scripts: true, characters: true, scenes: true, episodes: true } },
      },
    });
    return NextResponse.json(projects);
  } catch (e) {
    console.error("[api/projects] GET", e);
    return NextResponse.json({ error: "获取项目列表失败" }, { status: 500 });
  }
}
