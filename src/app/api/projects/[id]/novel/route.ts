/**
 * POST /api/projects/[id]/novel — 上传/更新小说文本
 * 支持：JSON { text } 粘贴 或 FormData file 上传（.txt/.md）
 * 解析分章 → 更新 Project.novelText / novelMeta / novelPath，置项目为 SCRIPTING
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseNovel } from "@/lib/novel/parser";
import { saveFile } from "@/lib/storage";

const MAX_SIZE = 3 * 1024 * 1024; // 3MB

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  let text: string | null = null;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (file instanceof File) {
      if (file.size > MAX_SIZE) return NextResponse.json({ error: "文件超过 3MB 限制" }, { status: 413 });
      text = await file.text();
    } else {
      const t = form.get("text");
      text = typeof t === "string" ? t : null;
    }
  } else {
    const body = await req.json().catch(() => null);
    text = typeof body?.text === "string" ? body.text : null;
  }

  if (!text || !text.trim()) {
    return NextResponse.json({ error: "小说内容为空" }, { status: 400 });
  }
  text = text.trim();
  if (text.length > 2_000_000) return NextResponse.json({ error: "文本过长（>200万字）" }, { status: 413 });

  // 保存文件副本 + 解析分章
  const relPath = saveFile("novels", text, ".txt");
  const meta = parseNovel(text);
  if (!meta.title && text.length > 200) {
    meta.title = text.slice(0, 80).split("\n")[0].slice(0, 40);
  }

  await prisma.project.update({
    where: { id },
    data: {
      novelPath: relPath,
      novelText: text,
      novelMeta: { ...meta, stage: "uploaded" } as never,
      status: "SCRIPTING",
    },
  });

  return NextResponse.json({
    ok: true,
    chapters: meta.chapters.length,
    charCount: meta.charCount,
    wordCount: meta.wordCount,
  });
}

/** GET /api/projects/[id]/novel — 章节元信息（标题/分章） */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  return NextResponse.json({ meta: project.novelMeta ?? null, hasText: Boolean(project.novelText) });
}
