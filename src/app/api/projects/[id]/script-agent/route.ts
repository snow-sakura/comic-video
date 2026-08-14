/**
 * POST /api/projects/[id]/script-agent — 触发剧本工坊 Agent
 * body: { stage: "characters" | "outline" | "script", episodeNumber?: number }
 * 创建 GenTask(LLM) → 入队 script 队列 → worker 执行并落库
 * GET  — 当前剧本工坊状态（stage / 角色 / 大纲 / 已生成剧本集数）
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueGenTask } from "@/lib/queue/queues";
import { getScriptStage } from "@/lib/agents";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    if (!project.novelText) return NextResponse.json({ error: "尚未上传小说" }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const stage = body?.stage as string | undefined;
    const episodeNumber = body?.episodeNumber ? Number(body.episodeNumber) : undefined;
    // 用户定制集数（提炼角色后可选覆盖，生成大纲按此数量）
    const episodeCount = body?.episodeCount ? Math.round(Number(body.episodeCount)) : undefined;
    if (episodeCount !== undefined && (!Number.isFinite(episodeCount) || episodeCount < 1 || episodeCount > 60)) {
      return NextResponse.json({ error: "集数必须在 1-60 之间" }, { status: 400 });
    }
    if (!["characters", "outline", "script"].includes(stage ?? "")) {
      return NextResponse.json({ error: "stage 必须是 characters | outline | script" }, { status: 400 });
    }
    if (stage === "script" && !episodeNumber) {
      return NextResponse.json({ error: "script 阶段需要 episodeNumber" }, { status: 400 });
    }

    // 前置依赖校验
    if (stage === "outline") {
      const count = await prisma.character.count({ where: { projectId: id } });
      if (count === 0) return NextResponse.json({ error: "请先运行「提炼角色」" }, { status: 400 });
    }
    if (stage === "script") {
      const script = await prisma.script.findFirst({ where: { projectId: id } });
      const content = (script?.content ?? {}) as { episodeOutlines?: unknown };
      if (!content.episodeOutlines) return NextResponse.json({ error: "请先运行「生成大纲」" }, { status: 400 });
    }

    // 幂等保护：同一 stage 进行中任务不可重复触发
    const existing = await prisma.genTask.findFirst({
      where: { projectId: id, type: "LLM", status: { in: ["QUEUED", "PROCESSING"] } },
    });
    if (existing) {
      return NextResponse.json({ error: "已有剧本任务进行中，请等待完成", runningTaskId: existing.id }, { status: 409 });
    }

    const task = await prisma.genTask.create({
      data: {
        projectId: id,
        label: `剧本工坊·${stage === "characters" ? "角色提炼" : stage === "outline" ? "分集大纲" : `第${episodeNumber}集剧本`}`,
        type: "LLM",
        provider: "script-agent",
        model: stage!,
        status: "QUEUED",
        input: { stage, episodeNumber, episodeCount } as never,
      },
    });

    await enqueueGenTask("script", {
      taskId: task.id,
      payload: {
        agent: stage,
        projectId: id,
        ...(episodeNumber ? { episodeNumber } : {}),
        ...(episodeCount !== undefined ? { episodeCount } : {}),
      },
    });

    return NextResponse.json({ ok: true, taskId: task.id });
  } catch (e) {
    console.error(`[script-agent] 操作失败: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}

/** GET — 剧本工坊状态聚合 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [project, characters, script, episodes, runningTask] = await Promise.all([
    prisma.project.findUnique({ where: { id } }),
    prisma.character.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } }),
    prisma.script.findFirst({ where: { projectId: id }, orderBy: { version: "desc" } }),
    prisma.episode.findMany({ where: { projectId: id }, orderBy: { number: "asc" } }),
    prisma.genTask.findFirst({
      where: { projectId: id, type: "LLM", status: { in: ["QUEUED", "PROCESSING"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const content = (script?.content ?? {}) as {
    episodes?: { number?: number; scenes?: unknown[] }[];
    worldView?: string;
    logline?: string;
  };
  const episodesContent = content.episodes ?? [];
  // 已生成 = 带完整场景列表的集
  const generatedEpisodes = episodesContent.filter(
    (e) => e && Array.isArray(e.scenes) && e.scenes.length > 0
  ).length;
  // 按集号索引的分集剧本（前端「展开分集剧本」读取，之前缺失导致永远显示空态）
  const episodeScripts: Record<number, unknown> = {};
  for (const e of episodesContent) {
    if (e && typeof e.number === "number" && Array.isArray(e.scenes) && e.scenes.length > 0) {
      episodeScripts[e.number] = e;
    }
  }
  return NextResponse.json({
    stage: await getScriptStage(id),
    hasNovel: Boolean(project.novelText),
    episodeCount: project.episodeCount ?? 6,
    chapters: ((project.novelMeta as { chapters?: unknown[] } | null)?.chapters?.length) ?? 0,
    characters,
    logline: script?.logline ?? null,
    worldView: content.worldView ?? null,
    generatedEpisodes,
    episodeScripts,
    episodes,
    runningTask: runningTask
      ? { id: runningTask.id, label: runningTask.label, status: runningTask.status, error: runningTask.error }
      : null,
  });
}
