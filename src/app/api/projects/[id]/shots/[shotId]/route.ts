/**
 * PATCH /api/projects/[id]/shots/[shotId] — 编辑分镜（P1-3 对白 / P1-4 手动分镜扩展）
 * body: { dialog?, dialogChar?, dialogEmotion?, sceneName?, action?, duration?, camera? }
 * 台词/角色/情绪任一变化时：若该镜已配音，清空 voicePath/subtitlePath 并回退状态
 * （有视频 → VIDEO_DONE，无视频 → IMAGE_DONE），提示需重新配音。
 * 画面类字段（sceneName/action/camera）变化且已出图/视频 → 作废下游产物并重组装提示词。
 *
 * DELETE /api/projects/[id]/shots/[shotId] — 删除镜头（P1-4）
 * 删除 DB 记录并清理产物文件（分镜图/视频/配音）。
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { removeFile } from "@/lib/storage";
import { assembleAllShotPrompts } from "@/lib/storyboard";

// ========== PATCH ==========

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
  const sceneName = typeof body?.sceneName === "string" ? body.sceneName.trim() : undefined;
  const action = typeof body?.action === "string" ? body.action.trim() : undefined;
  const duration = typeof body?.duration === "number" ? body.duration : undefined;
  const camera = body?.camera && typeof body.camera === "object" ? (body.camera as Record<string, string>) : undefined;

  const hasAny = [dialog, dialogChar, dialogEmotion, sceneName, action, duration, camera].some(
    (v) => v !== undefined
  );
  if (!hasAny) {
    return NextResponse.json({
      error: "至少提供一个字段：dialog / dialogChar / dialogEmotion / sceneName / action / duration / camera",
    }, { status: 400 });
  }

  const voicedChanged =
    (dialog !== undefined && dialog !== shot.dialog) ||
    (dialogChar !== undefined && dialogChar !== shot.dialogChar) ||
    (dialogEmotion !== undefined && dialogEmotion !== shot.dialogEmotion);
  // 画面类字段变化（场景/动作/镜头语言）→ 作废已出图/视频等下游产物
  const visualChanged =
    (sceneName !== undefined && sceneName !== shot.sceneName) ||
    (action !== undefined && action !== shot.action) ||
    (camera !== undefined && JSON.stringify(camera) !== JSON.stringify((shot.camera ?? {}) as Record<string, string>));

  const wasVoiced =
    Boolean(shot.voicePath) || Boolean(shot.subtitlePath) || shot.status.startsWith("VOICE");
  const hasVisualProduct = Boolean(shot.imagePath) || Boolean(shot.videoPath) || shot.status.startsWith("IMAGE");

  const updated = await prisma.shot.update({
    where: { id: shotId },
    data: {
      ...(dialog !== undefined ? { dialog: dialog || null } : {}),
      ...(dialogChar !== undefined ? { dialogChar: dialogChar || null } : {}),
      ...(dialogEmotion !== undefined ? { dialogEmotion: dialogEmotion || null } : {}),
      ...(sceneName !== undefined ? { sceneName: sceneName || null } : {}),
      ...(action !== undefined ? { action: action || null } : {}),
      ...(duration !== undefined && duration > 0 ? { duration } : {}),
      ...(camera ? { camera: camera as never } : {}),
      // 台词/角色/情绪变化且已配音 → 作废旧配音与字幕
      ...(voicedChanged && wasVoiced
        ? { voicePath: null, subtitlePath: null, status: shot.videoPath ? "VIDEO_DONE" : "IMAGE_DONE" }
        : {}),
      // 画面类变化且已有图/视频 → 作废下游产物，回到待出图
      ...(visualChanged && hasVisualProduct
        ? { imagePath: null, videoPath: null, voicePath: null, subtitlePath: null, status: "PROMPT_READY" }
        : {}),
    },
  });

  // 画面变化 → 重组装 7 维提示词与参考图（幂等）
  if (visualChanged) {
    await assembleAllShotPrompts(id, shot.episodeId);
  }

  return NextResponse.json({ ok: true, shot: { id: updated.id, status: updated.status } });
}

// ========== DELETE ==========

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; shotId: string }> }
): Promise<NextResponse> {
  const { id, shotId } = await params;
  const shot = await prisma.shot.findFirst({ where: { id: shotId, episode: { projectId: id } } });
  if (!shot) return NextResponse.json({ error: "镜头不存在" }, { status: 404 });

  // 清理产物文件（尽力而为，不阻断删除）
  for (const p of [shot.imagePath, shot.videoPath, shot.voicePath]) {
    if (p) removeFile(p);
  }
  await prisma.shot.delete({ where: { id: shotId } });
  return NextResponse.json({ ok: true });
}
