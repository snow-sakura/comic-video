/**
 * 本地文件存储管理（单用户工具，无需 S3）
 * storage/
 *   novels/ characters/ scenes/ props/ shots/ videos/ audio/ subs/ temp/
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { nanoid } from "nanoid";
import { loadEnv } from "@/lib/env";

loadEnv();

export const STORAGE_ROOT = resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? "./storage");

const DIRS = {
  novels: "novels",
  characters: "characters",
  scenes: "scenes",
  props: "props",
  shots: "shots",
  clips: "clips",
  videos: "videos",
  audio: "audio",
  subs: "subs",
  bgm: "bgm",
  sfx: "sfx",
  temp: "temp",
} as const;

export type StorageCategory = keyof typeof DIRS;

function ensureDir(cat: StorageCategory): string {
  const dir = join(STORAGE_ROOT, DIRS[cat]);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 确保全部目录存在 */
export function ensureStorage(): void {
  for (const cat of Object.keys(DIRS) as StorageCategory[]) {
    ensureDir(cat);
  }
}

/** 生成唯一文件名（保留扩展名） */
export function uniqueName(cat: StorageCategory, ext = ".png"): { dir: string; path: string; relPath: string } {
  const dir = ensureDir(cat);
  const name = `${Date.now()}-${nanoid(8)}${ext.startsWith(".") ? ext : "." + ext}`;
  return { dir, path: join(dir, name), relPath: join(DIRS[cat], name) };
}

/** 保存 Buffer/string 到存储，返回相对路径 */
export function saveFile(cat: StorageCategory, data: Buffer | string, ext?: string): string {
  const { path, relPath } = uniqueName(cat, ext);
  writeFileSync(path, data);
  return relPath;
}

/** 类别目录的绝对路径（自动创建） */
export function getCategoryDir(cat: StorageCategory): string {
  return ensureDir(cat);
}

/** 读取相对路径文件为 Buffer */
export function readFile(relPath: string): Buffer {
  return readFileSync(resolve(STORAGE_ROOT, relPath));
}

/** 相对路径 → 绝对路径 */
export function absPath(relPath: string): string {
  return resolve(STORAGE_ROOT, relPath);
}

/** 相对路径 → data URI（供 API 参考图参数） */
export function toDataUri(relPath: string, mime = "image/png"): string {
  const buf = readFile(relPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 判断文件是否存在 */
export function fileExists(relPath: string): boolean {
  return existsSync(resolve(STORAGE_ROOT, relPath));
}

/** 删除相对路径文件（不存在时静默） */
export function removeFile(relPath: string): boolean {
  try {
    unlinkSync(resolve(STORAGE_ROOT, relPath));
    return true;
  } catch {
    return false;
  }
}

/** 下载 URL 到存储，返回相对路径 */
export async function downloadToStorage(url: string, cat: StorageCategory, ext?: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const guessed = ext ?? (extname(new URL(url).pathname) || ".png");
  return saveFile(cat, buf, guessed);
}

/** 获取文件扩展名 */
export function getExt(relPath: string): string {
  return extname(relPath) || ".png";
}
