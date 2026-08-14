/**
 * GET /api/files?path=characters/xxx.png — 读取本地存储文件
 * 单用户工具：仅允许 storage 目录内的相对路径。
 *
 * - 流式返回（createReadStream），避免 readFileSync 阻塞事件循环（大视频/大图关键）
 * - 支持 HTTP Range 请求（<video> 拖动进度条 / 断点续传必需，否则浏览器会整体重下）
 */
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
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

/** 将绝对路径解析为 storage 内相对路径，非法（穿越/不存在）返回 null */
async function resolveStoragePath(raw: string): Promise<string | null> {
  if (!raw) return null;
  const rel = normalize(raw).replace(/^\/+/, "");
  if (isAbsolute(rel) || rel.startsWith("..")) return null;
  const abs = join(STORAGE_ROOT, rel);
  if (!abs.startsWith(STORAGE_ROOT)) return null;
  try {
    const s = await stat(abs);
    if (!s.isFile()) return null;
  } catch {
    return null; // 不存在/无权限
  }
  return rel;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("path") ?? "";
  if (!raw) return NextResponse.json({ error: "缺少 path" }, { status: 400 });

  const rel = await resolveStoragePath(raw);
  if (!rel) {
    // 区分非法路径与不存在
    const norm = normalize(raw).replace(/^\/+/, "");
    const illegal = isAbsolute(norm) || norm.startsWith("..") || !join(STORAGE_ROOT, norm).startsWith(STORAGE_ROOT);
    return NextResponse.json({ error: illegal ? "非法路径" : "文件不存在" }, { status: illegal ? 400 : 404 });
  }

  const abs = join(STORAGE_ROOT, rel);
  const { size } = await stat(abs);
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const baseHeaders = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  // ---- Range 请求（视频 seek / 断点续传） ----
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = 0;
    let end = size - 1;
    if (m) {
      if (m[1]) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
      } else if (m[2]) {
        // 后缀范围：bytes=-N → 最后 N 字节
        const n = parseInt(m[2], 10);
        start = Math.max(0, size - n);
      } else {
        return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    const stream = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  // ---- 全量流式 ----
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
