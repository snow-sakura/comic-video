/**
 * PATCH /api/projects/[id]/shots/[shotId] — 编辑分镜对白（P1-3）
 * body: { dialog?, dialogChar?, dialogEmotion? }
 * 台词/角色/情绪任一变化时：若该镜已配音，清空 voicePath/subtitlePath 并回退状态
 * （有视频 → VIDEO_DONE，无视频 → IMAGE_DONE），提示需重新配音。
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; shotId: string }> }
): Promise<NextResponse> {
  const { id, shotId } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const shot = await prisma.shot.findUnique({
    where: { id: shotId },
    include: { episode: { select: { projectId: true } } },
  });
  if (!shot || shot.episode?.projectId !== id) {
    return NextResponse.json({ error: "镜头不存在" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const dialog = typeof body?.dialog === "string" ? body.dialog.trim() : undefined;
  const dialogChar = typeof body?.dialogChar === "string" ? body.dialogChar.trim() : undefined;
  const dialogEmotion = typeof body?.dialogEmotion === "string" ? body.dialogEmotion.trim() : undefined;
  if (dialog === undefined && dialogChar === undefined && dialogEmotion === undefined) {
    return NextResponse.json({ error: "至少提供一个字段：dialog / dialogChar / dialogEmotion" }, { status: 400 });
  }

  const changed =
    (dialog !== undefined && dialog !== shot.dialog) ||
    (dialogChar !== undefined && dialogChar !== shot.dialogChar) ||
    (dialogEmotion !== undefined && dialogEmotion !== shot.dialogEmotion);

  const wasVoiced =
    Boolean(shot.voicePath) || Boolean(shot.subtitlePath) || shot.status.startsWith("VOICE");

  const updated = await prisma.shot.update({
    where: { id: shotId },
    data: {
      ...(dialog !== undefined ? { dialog: dialog || null } : {}),
      ...(dialogChar !== undefined ? { dialogChar: dialogChar || null } : {}),
      ...(dialogEmotion !== undefined ? { dialogEmotion: dialogEmotion || null } : {}),
      // 台词/角色/情绪变化且已配音 → 作废旧配音与字幕
      ...(changed && wasVoiced
        ? { voicePath: null, subtitlePath: null, status: shot.videoPath ? "VIDEO_DONE" : "IMAGE_DONE" }
        : {}),
    },
  });

  return NextResponse.json({ ok: true, shot: { id: updated.id, dialog: updated.dialog, status: updated.status } });
}
