/**
 * 字幕工具 — 时间戳估算 + SRT 序列化
 * 说明：CosyVoice/Mock 均为非流式合成，无逐句时间戳；
 * 按"语速 ≈ 4字/秒"启发式切句并均分时长，生成字幕时间轴。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TTSSubtitle } from "@/lib/providers/types";
import { absPath } from "@/lib/storage";

const execFileAsync = promisify(execFile);

/** 探测音频时长（秒，ffprobe） */
export async function probeAudioDuration(relPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    absPath(relPath),
  ]);
  const n = parseFloat(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`无法解析音频时长: ${relPath}`);
  return n;
}

/** 移除 SSML/情绪标签等尖括号内容（字幕纯文本） */
export function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** 按标点与长度切句（每句 ≤ MAX_CUE 字） */
export function splitCues(text: string, maxLen = 18): string[] {
  const clean = stripTags(text);
  if (!clean) return [];
  // 先按标点切分，再合并过短片段
  const parts = clean.split(/(?<=[。！？!?；;，,、])/).map((s) => s.trim()).filter(Boolean);
  const cues: string[] = [];
  let buf = "";
  for (const part of parts) {
    if ((buf + part).length <= maxLen * 2 && !buf.endsWith("。") && !buf.endsWith("！") && !buf.endsWith("？")) {
      buf += part;
      if (buf.length >= maxLen) {
        cues.push(buf);
        buf = "";
      }
    } else {
      if (buf) cues.push(buf);
      buf = part;
    }
    if (buf.length >= maxLen * 2) {
      cues.push(buf);
      buf = "";
    }
  }
  if (buf) cues.push(buf);
  return cues;
}

/**
 * 估算字幕时间轴：按字数比例分配 totalSec 时长
 * @param text 原始文本（含情绪标签）
 * @param totalSec 音频总时长（秒）
 */
export function estimateSubtitles(text: string, totalSec: number): TTSSubtitle[] {
  const cues = splitCues(text);
  if (cues.length === 0) return [];
  const totalChars = cues.reduce((n, c) => n + c.length, 0);
  const totalMs = Math.max(1, totalSec * 1000);
  let cursor = 0;
  return cues.map((c) => {
    const dur = Math.max(600, Math.round((c.length / totalChars) * totalMs));
    const cue: TTSSubtitle = { start: cursor, end: Math.min(totalMs, cursor + dur), text: c };
    cursor += dur;
    return cue;
  });
}

/** ms → SRT 时间格式 00:00:00,000（毫秒必须取整，libass 解析浮点毫秒会失败） */
export function srtTime(ms: number): string {
  const r = Math.round(ms);
  const h = Math.floor(r / 3600000);
  const m = Math.floor((r % 3600000) / 60000);
  const s = Math.floor((r % 60000) / 1000);
  const mm = r % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mm, 3)}`;
}

/** 生成 SRT 文件内容；offsetSec 为相对某时间轴的偏移（合成时累加各镜头时长） */
export function cuesToSrt(cues: TTSSubtitle[], offsetSec = 0): string {
  const offsetMs = Math.round(offsetSec * 1000);
  return cues
    .map((c, i) => {
      const text = stripTags(c.text);
      if (!text) return "";
      return `${i + 1}\n${srtTime(c.start + offsetMs)} --> ${srtTime(c.end + offsetMs)}\n${text}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

/** VTT 时间格式 00:00:00.000（逗号→句点） */
function vttTime(ms: number): string {
  return srtTime(ms).replace(",", ".");
}

/** 生成 WebVTT（浏览器 <video><track> 原生可显示） */
export function cuesToVtt(cues: TTSSubtitle[], offsetSec = 0): string {
  const offsetMs = Math.round(offsetSec * 1000);
  return [
    "WEBVTT",
    "",
    ...cues
      .map((c) => {
        const text = stripTags(c.text);
        if (!text) return "";
        return `${vttTime(c.start + offsetMs)} --> ${vttTime(c.end + offsetMs)}\n${text}\n`;
      })
      .filter(Boolean),
  ].join("\n");
}
