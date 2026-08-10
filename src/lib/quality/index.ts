/**
 * 质量检查（QC）— 生成资产自动质检，P1-1
 *
 * 策略：结构完整性（ffprobe）+ 黑帧/纯色启发式（ffmpeg 抽帧分析）。
 *  - FAIL  → 抛出错误 → 队列 attempts=3 自动重试（≤2 次重试）
 *  - WARN  → 仅记录，不阻断
 *
 * 阈值说明（对纯色/深色静帧图生视频友好）：
 *  - 亮度均值 < 10 → 近全黑，判 FAIL（mock 纯色 0x2a2a4a 亮度 ≈53，不受影响）
 *  - 亮度均值 < 30 且 ≥2 帧 → 偏暗 WARN
 *  - 方差 < 4 → 纯色/冻结帧 WARN（不判失败：静帧视频合法）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { absPath } from "@/lib/storage";

const execFileAsync = promisify(execFile);

export interface QCResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function okResult(): QCResult {
  return { ok: true, errors: [], warnings: [] };
}

/** 媒体结构探测（ffprobe 读取首个视频/音频流） */
export async function probeMedia(
  relPath: string
): Promise<{ hasVideo: boolean; hasAudio: boolean; width: number; height: number; duration: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height",
    "-show_entries", "format=duration",
    "-of", "json",
    absPath(relPath),
  ]);
  const info = JSON.parse(stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const v = (info.streams ?? []).find((s) => s.codec_type === "video");
  const a = (info.streams ?? []).find((s) => s.codec_type === "audio");
  return {
    hasVideo: !!v,
    hasAudio: !!a,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    duration: parseFloat(info.format?.duration ?? "0") || 0,
  };
}

/** 抽帧（缩到 64x36 灰度，约 3fps，上限 ~30 帧）→ 原始像素 Buffer */
async function sampleFrames(relPath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-v", "error",
    "-i", absPath(relPath),
    "-vf", "scale=64:36,format=gray,fps=3",
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "-",
  ], { maxBuffer: 8 * 1024 * 1024 });
  return Buffer.from(stdout);
}

interface FrameStats {
  mean: number;
  variance: number;
}

const FRAME_W = 64;
const FRAME_H = 36;

function frameStats(buf: Buffer, offset: number): FrameStats {
  let sum = 0;
  let sumSq = 0;
  const n = FRAME_W * FRAME_H;
  for (let i = 0; i < n; i++) {
    const p = buf[offset + i] ?? 0;
    sum += p;
    sumSq += p * p;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { mean, variance };
}

/** 视频 QC：结构 + 黑帧启发式 */
export async function qcVideo(relPath: string): Promise<QCResult> {
  const r = okResult();
  let probe;
  try {
    probe = await probeMedia(relPath);
  } catch (e) {
    r.errors.push(`无法解析媒体文件: ${(e as Error).message}`);
    r.ok = false;
    return r;
  }
  if (!probe.hasVideo) r.errors.push("缺少视频流");
  if (probe.width <= 0 || probe.height <= 0) r.errors.push(`分辨率异常: ${probe.width}x${probe.height}`);
  if (probe.duration < 0.5) r.errors.push(`时长过短: ${probe.duration.toFixed(2)}s`);
  if (probe.duration > 30) r.warnings.push(`时长超预期: ${probe.duration.toFixed(1)}s（成片上限 30s/集）`);

  // 抽帧分析（解码失败不判失败，交给结构检查兜底）
  let frames: Buffer | undefined;
  try {
    frames = await sampleFrames(relPath);
  } catch {
    r.warnings.push("抽帧失败（可能解码受限），跳过画面检查");
  }
  if (frames && frames.length >= FRAME_W * FRAME_H) {
    const frameCount = Math.floor(frames.length / (FRAME_W * FRAME_H));
    const means: number[] = [];
    const variances: number[] = [];
    for (let i = 0; i < frameCount; i++) {
      const s = frameStats(frames, i * FRAME_W * FRAME_H);
      means.push(s.mean);
      variances.push(s.variance);
    }
    const avgMean = means.reduce((a, b) => a + b, 0) / means.length;
    const darkCount = means.filter((m) => m < 30).length;
    const flatCount = variances.filter((v) => v < 4).length;
    if (avgMean < 10) r.errors.push(`画面近全黑（亮度均值 ${avgMean.toFixed(1)}）`);
    else if (darkCount >= 2) r.warnings.push(`${darkCount}/${frameCount} 帧偏暗`);
    if (flatCount === frameCount) r.warnings.push("画面为纯色/冻结帧（静帧视频合法，仅提示）");
  }

  // 文件大小（4KB 以下疑似损坏或空壳；纯色 mock 视频压缩后可能仅 ~8KB）
  try {
    const st = await stat(absPath(relPath));
    if (st.size < 4 * 1024) r.warnings.push(`文件过小: ${(st.size / 1024).toFixed(1)}KB`);
  } catch {
    r.errors.push("文件不存在或不可读");
  }

  r.ok = r.errors.length === 0;
  return r;
}

/** 图片 QC：可解码 + 非全黑/全白（抽帧分析首帧） */
export async function qcImage(relPath: string): Promise<QCResult> {
  const r = okResult();
  try {
    const probe = await probeMedia(relPath);
    if (!probe.hasVideo) {
      r.errors.push("图片无有效像素流");
    } else {
      if (probe.width <= 0 || probe.height <= 0) r.errors.push(`尺寸异常: ${probe.width}x${probe.height}`);
      const frames = await sampleFrames(relPath);
      if (frames.length >= FRAME_W * FRAME_H) {
        const s = frameStats(frames, 0);
        if (s.mean < 10) r.errors.push("图片近全黑");
        if (s.mean > 245) r.errors.push("图片近全白");
        if (s.variance < 4) r.warnings.push("图片为纯色块");
      }
    }
  } catch (e) {
    r.errors.push(`无法解析图片: ${(e as Error).message}`);
  }
  r.ok = r.errors.length === 0;
  return r;
}
