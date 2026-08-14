/**
 * POST   /api/projects — 创建项目（仅需标题；集数与小说导入在详情页操作）
 * GET    /api/projects — 项目列表
 * DELETE /api/projects — 批量删除项目（级联删除全部关联数据 + 清理磁盘小说文件）
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { STORAGE_ROOT } from "@/lib/storage";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const createSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(100),
  // AI 定制集数：分集大纲 / 分集剧本的前置数量（1-50），默认 6
  episodeCount: z.number().int().min(1, "集数至少 1 集").max(50, "集数最多 50 集").optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = createSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: body.error.issues[0]?.message ?? "参数错误" }, { status: 400 });
    }
    const { title, episodeCount } = body.data;

    const project = await prisma.project.create({
      data: {
        title,
        episodeCount: episodeCount ?? 6,
      },
    });
    return NextResponse.json(project, { status: 201 });
  } catch (e) {
    console.error("[api/projects] POST", e);
    return NextResponse.json({ error: "创建项目失败" }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const take = Math.min(100, Math.max(1, Number(searchParams.get("take")) || 50));
    const cursor = searchParams.get("cursor") || undefined;

    const projects = await prisma.project.findMany({
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { scripts: true, characters: true, scenes: true, episodes: true } },
        // 剧本行（含 content 供前端统计「已生成完整分集剧本数」，
        // approved 字段无写入入口，不能用它判断完成态）
        scripts: {
          select: { id: true, approved: true, version: true, status: true, content: true },
          orderBy: { version: "desc" },
          take: 50,
        },
        // 角色 / 场景 / 道具 → refImageIds 非空表示该资产已有设计图
        characters: {
          select: { id: true, name: true, refImageIds: true },
          take: 50,
        },
        scenes: {
          select: { id: true, name: true, refImageIds: true },
          take: 50,
        },
        assets: {
          select: { id: true, type: true },
          take: 50,
        },
        // 剧集 → finalPath 表示成片已合成；shots 状态用于判断「分镜·出图」完成度
        episodes: {
          select: {
            id: true,
            number: true,
            status: true,
            finalPath: true,
            shots: { select: { status: true } },
          },
          orderBy: { number: "asc" },
        },
        // 仅取未完成任务用于推断执行状态（执行中/暂停/失败），限制数量避免大项目拉全表
        tasks: {
          where: { status: { in: ["PROCESSING", "QUEUED", "PAUSED", "FAILED"] } },
          select: { status: true, type: true },
          take: 100,
        },
      },
    });
    const nextCursor = projects.length === take ? projects[projects.length - 1]?.id : null;
    return NextResponse.json({ projects, nextCursor });
  } catch (e) {
    console.error("[api/projects] GET", e);
    return NextResponse.json({ error: "获取项目列表失败" }, { status: 500 });
  }
}

const deleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "至少选择一个项目").max(50, "一次最多删除 50 个项目"),
});

export async function DELETE(req: Request): Promise<NextResponse> {
  try {
    const body = deleteSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: body.error.issues[0]?.message ?? "参数错误" }, { status: 400 });
    }
    const { ids } = body.data;

    // 1) 先取目标项目（拿 novelPath 用于磁盘清理）
    const targets = await prisma.project.findMany({
      where: { id: { in: ids } },
      select: { id: true, novelPath: true },
    });
    const foundIds = targets.map((t) => t.id);
    const missing = ids.filter((id) => !foundIds.includes(id));
    if (missing.length > 0) {
      return NextResponse.json({ error: `项目不存在：${missing.join(", ")}` }, { status: 404 });
    }

    // 2) 级联删除：Script/Character/Scene/Asset/Episode/Shot/GenTask 均已配置 onDelete: Cascade
    await prisma.project.deleteMany({ where: { id: { in: foundIds } } });

    // 3) 清理磁盘：删除上传的小说原件（其余素材由 storage 管理，无引用即为垃圾文件）
    for (const t of targets) {
      if (t.novelPath) {
        try {
          const p = join(STORAGE_ROOT, t.novelPath);
          if (existsSync(p)) rmSync(p);
        } catch (e) {
          console.warn("[api/projects] DELETE novel 清理失败", t.id, e);
        }
      }
    }
    return NextResponse.json({ ok: true, deleted: foundIds.length });
  } catch (e) {
    console.error("[api/projects] DELETE", e);
    return NextResponse.json({ error: "删除项目失败" }, { status: 500 });
  }
}