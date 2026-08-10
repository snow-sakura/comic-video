/**
 * 导出与分享：将整集资源打包为 ZIP（成片 + 字幕 + 镜头素材 + 剧本 + 清单）
 * 输出到 storage/exports/，可复用缓存，通过 /api/projects/[id]/export 下载。
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { STORAGE_ROOT, fileExists, readFile, absPath } from "@/lib/storage";
import { prisma as db } from "@/lib/db";
import { buildZip, type ZipEntry } from "@/lib/zip";

export interface ExportMeta {
  projectId: string;
  title: string;
  episode: number;
  episodeTitle: string;
  shotCount: number;
  createdAt: string;
}

/** 生成整集 ZIP 导出，返回相对路径（已存在则复用） */
export async function buildEpisodeExport(projectId: string, episodeNumber: number): Promise<string> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("项目不存在");
  const episode = await db.episode.findFirst({ where: { projectId, number: episodeNumber } });
  if (!episode) throw new Error("剧集不存在");
  const shots = await db.shot.findMany({
    where: { episodeId: episode.id },
    orderBy: { sequence: "asc" },
  });
  const script = await db.script.findFirst({ where: { projectId } });

  const safeTitle = project.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "project";
  const rootName = `${safeTitle}-ep${episode.number}-export`;
  const zipName = `${rootName}.zip`;
  const zipRel = `exports/${zipName}`;
  const zipPath = join(STORAGE_ROOT, "exports", zipName);

  // 缓存复用：非空 zip 已存在则直接返回（单用户工具，简单策略）
  if (fileExists(zipRel) && statSync(absPath(zipRel)).size > 0) return zipRel;

  const entries: ZipEntry[] = [];

  const manifest: ExportMeta & {
    shots: Array<{
      sequence: number;
      sceneName: string | null;
      status: string;
      duration: number;
      dialog: string | null;
      image: string | null;
      video: string | null;
      voice: string | null;
    }>;
  } = {
    projectId,
    title: project.title,
    episode: episode.number,
    episodeTitle: episode.title ?? "",
    shotCount: shots.length,
    createdAt: new Date().toISOString(),
    shots: shots.map((s) => ({
      sequence: s.sequence,
      sceneName: s.sceneName,
      status: s.status,
      duration: s.duration,
      dialog: s.dialog,
      image: s.imagePath,
      video: s.videoPath,
      voice: s.voicePath,
    })),
  };
  entries.push({ name: `${rootName}/manifest.json`, data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });

  if (episode.finalPath && fileExists(episode.finalPath)) {
    const base = basename(episode.finalPath, extname(episode.finalPath));
    const ext = extname(episode.finalPath);
    entries.push({ name: `${rootName}/final/${base}${ext}`, data: readFile(episode.finalPath) });
    for (const sub of [".srt", ".vtt"]) {
      const subRel = episode.finalPath.replace(/\.mp4$/, sub);
      if (fileExists(subRel)) {
        entries.push({ name: `${rootName}/final/${base}${sub}`, data: readFile(subRel) });
      }
    }
  }

  for (const s of shots) {
    const dir = `${rootName}/shots/${String(s.sequence).padStart(2, "0")}-${s.sceneName || "shot"}`;
    if (s.imagePath && fileExists(s.imagePath)) {
      entries.push({ name: `${dir}/image${extname(s.imagePath)}`, data: readFile(s.imagePath) });
    }
    if (s.videoPath && fileExists(s.videoPath)) {
      entries.push({ name: `${dir}/video${extname(s.videoPath)}`, data: readFile(s.videoPath) });
    }
    if (s.voicePath && fileExists(s.voicePath)) {
      entries.push({ name: `${dir}/voice${extname(s.voicePath)}`, data: readFile(s.voicePath) });
    }
    entries.push({
      name: `${dir}/dialog.json`,
      data: Buffer.from(
        JSON.stringify(
          {
            sequence: s.sequence,
            sceneName: s.sceneName,
            action: s.action,
            dialog: s.dialog,
            dialogChar: s.dialogChar,
            duration: s.duration,
            status: s.status,
            camera: s.camera,
            finalPrompt: s.finalPrompt,
          },
          null,
          2,
        ),
        "utf8",
      ),
    });
  }

  if (script?.content) {
    const content =
      typeof script.content === "string" ? script.content : JSON.stringify(script.content, null, 2);
    entries.push({ name: `${rootName}/script.json`, data: Buffer.from(content, "utf8") });
  }

  const zipBuf = buildZip(entries);
  mkdirSync(join(STORAGE_ROOT, "exports"), { recursive: true });
  writeFileSync(zipPath, zipBuf);

  if (!existsSync(zipPath)) throw new Error("导出失败：ZIP 未生成");
  return zipRel;
}

/** 读取导出 zip（供 API 返回流） */
export function readExportZip(zipRel: string): Buffer {
  return readFile(zipRel);
}
