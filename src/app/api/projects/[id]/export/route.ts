import { NextResponse } from "next/server";
import { buildEpisodeExport, readExportZip } from "@/lib/export";
import { prisma as db } from "@/lib/db";
import { loadEnv } from "@/lib/env";

loadEnv();

/**
 * GET /api/projects/[projectId]/export?episode=N
 * 生成（或复用）整集 ZIP 导出并返回文件流。
 * 同一 URL 即可作为"分享链接"使用。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await params;
  const url = new URL(_req.url);
  const episodeNumber = Number(url.searchParams.get("episode")) || 1;

  try {
    const episode = await db.episode.findFirst({ where: { projectId, number: episodeNumber } });
    if (!episode) return NextResponse.json({ error: "剧集不存在" }, { status: 404 });

    const zipRel = await buildEpisodeExport(projectId, episodeNumber);
    const buf = readExportZip(zipRel);
    const project = await db.project.findUnique({ where: { id: projectId } });
    // RFC 5987：ASCII 兜底 + UTF-8 中文文件名（header 不允许非 Latin-1）
    const asciiName = `${project?.title ?? "project"}-ep${episodeNumber}-export.zip`.replace(/[^\x20-\x7e]/g, "_");
    const utf8Name = encodeURIComponent(`${project?.title ?? "project"}-ep${episodeNumber}-export.zip`);

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "导出失败" }, { status: 500 });
  }
}
