/**
 * GET /api/files?path=characters/xxx.png — 读取本地存储文件
 * 单用户工具：仅允许 storage 目录内的相对路径。
 */
import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, isAbsolute } from "node:path";
import { STORAGE_ROOT } from "@/lib/storage";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".srt": "text/plain",
  ".vtt": "text/vtt",
  ".txt": "text/plain",
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("path") ?? "";
  if (!raw) return NextResponse.json({ error: "缺少 path" }, { status: 400 });

  // 防目录穿越
  const rel = normalize(raw).replace(/^\/+/, "");
  if (isAbsolute(rel) || rel.startsWith("..")) {
    return NextResponse.json({ error: "非法路径" }, { status: 400 });
  }
  const abs = join(STORAGE_ROOT, rel);
  if (!abs.startsWith(STORAGE_ROOT)) {
    return NextResponse.json({ error: "非法路径" }, { status: 400 });
  }
  if (!existsSync(abs)) return NextResponse.json({ error: "文件不存在" }, { status: 404 });

  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const buf = readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
