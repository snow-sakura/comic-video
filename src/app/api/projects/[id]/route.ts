/**
 * GET    /api/projects/[id] — 项目详情（含剧本/角色/场景/资产/集数）
 * PATCH  /api/projects/[id] — 更新（标题/状态/风格）
 * DELETE /api/projects/[id] — 删除（级联清理子表）
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";

type Params = Promise<{ id: string }>;

const updateSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  status: z.enum(["DRAFT", "SCRIPTING", "ASSETING", "STORYBOARDING", "RENDERING", "DONE"]).optional(),
  style: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(_req: Request, { params }: { params: Params }): Promise<NextResponse> {
  const { id } = await params;
  try {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        scripts: { orderBy: { updatedAt: "desc" } },
        characters: { orderBy: { createdAt: "asc" } },
        scenes: { orderBy: { createdAt: "asc" } },
        assets: { orderBy: { createdAt: "asc" } },
        episodes: { orderBy: { number: "asc" } },
        tasks: { orderBy: { createdAt: "desc" }, take: 20 },
      },
    });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    return NextResponse.json(project);
  } catch (e) {
    console.error("[api/projects/:id] GET", e);
    return NextResponse.json({ error: "获取项目失败" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Params }): Promise<NextResponse> {
  const { id } = await params;
  try {
    const body = updateSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: body.error.issues[0]?.message ?? "参数错误" }, { status: 400 });
    }
    const project = await prisma.project.update({
      where: { id },
      data: {
        ...body.data,
        style: body.data.style as Prisma.InputJsonValue | undefined,
      },
    });
    return NextResponse.json(project);
  } catch (e) {
    console.error("[api/projects/:id] PATCH", e);
    return NextResponse.json({ error: "更新项目失败" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Params }): Promise<NextResponse> {
  const { id } = await params;
  try {
    await prisma.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/projects/:id] DELETE", e);
    return NextResponse.json({ error: "删除项目失败" }, { status: 500 });
  }
}
