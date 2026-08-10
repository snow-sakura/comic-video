/**
 * M4 合成引擎 — ffmpeg 逐镜头混音 + concat 拼接 + 可选 BGM + SRT 字幕烧录
 * 流程：
 *   1. 每镜头：视频 + 配音（如有）→ clip（音频重编码 aac，视频尽量 copy）
 *   2. concat demuxer 拼接全部 clip → 成片
 *   3. 可选：BGM 素材混音（volume 压低、循环截断到成片时长）
 *   4. 字幕：汇总各镜字幕 → 生成 SRT → 烧录（失败降级为仅保留 SRT 文件）
 * 失败降级：concat -c copy 失败时重编码视频轨重试。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { absPath, uniqueName } from "@/lib/storage";
import { getMusic } from "@/lib/providers/registry";
import type { TTSSubtitle } from "@/lib/providers/types";
import { cuesToSrt, cuesToVtt } from "@/lib/tts/subtitles";

const execFileAsync = promisify(execFile);

/** subtitles 滤镜可用性（ffmpeg 精简构建可能无 libass），首次探测后缓存 */
let hasSubtitlesFilterCache: boolean | null = null;
async function hasSubtitlesFilter(): Promise<boolean> {
  if (hasSubtitlesFilterCache !== null) return hasSubtitlesFilterCache;
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-filters"]);
    hasSubtitlesFilterCache = stdout.split("\n").some((l) => /subtitles|ass\s/.test(l));
  } catch {
    hasSubtitlesFilterCache = false;
  }
  return hasSubtitlesFilterCache;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 按相对路径读取媒体文件时长（ffprobe，秒） */
async function probeDuration(relPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    absPath(relPath),
  ]);
  const n = parseFloat(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`无法解析媒体时长: ${relPath}`);
  return n;
}

/** ffmpeg filter 内路径转义（冒号/反斜杠/单引号） */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** 读取视频主分辨率（不存在时抛错） */
async function probeVideoSize(relPath: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    absPath(relPath),
  ]);
  const [w, h] = stdout.trim().split(",").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`无法解析视频分辨率: ${relPath}`);
  return { w, h };
}

/** 检查媒体是否有音频流 */
async function hasAudioStream(relPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
      absPath(relPath),
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ========== 转场库 ==========

const XFADE_DUR = 0.4; // 镜头间叠化时长（秒）
const FADE_DUR = 0.5; // 片头淡入 / 片尾淡出（秒）

/**
 * 镜头间叠化（xfade）+ 片头淡入/片尾淡出
 * 内部将全部 clip 归一化到首镜分辨率（scale+pad）、25fps、yuv420p；
 * 无音轨 clip 自动补静音轨。失败抛错 → 调用方降级为 concat。
 */
async function composeWithTransitions(
  clipRels: string[],
  durations: number[],
  outPath: string
): Promise<void> {
  const n = clipRels.length;
  const total = durations.reduce((a, b) => a + b, 0);
  const outDur = total - (n - 1) * XFADE_DUR;

  const { w, h } = await probeVideoSize(clipRels[0]);
  const norm = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p,setsar=1`;

  const inputs: string[] = [];
  const parts: string[] = [];
  const audioRefs: string[] = [];
  let nextInput = n;

  for (let i = 0; i < n; i++) {
    inputs.push("-i", absPath(clipRels[i]));
    parts.push(`[${i}:v]${norm}[v${i}]`);
    if (await hasAudioStream(clipRels[i])) {
      audioRefs.push(`[a${i}]`);
      parts.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
    } else {
      inputs.push("-f", "lavfi", "-t", String(durations[i]), "-i", "anullsrc=r=48000:cl=stereo");
      audioRefs.push(`[a${nextInput}]`);
      parts.push(`[${nextInput}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${nextInput}]`);
      nextInput++;
    }
  }

  if (n === 1) {
    parts.push(
      `[v0]fade=t=in:st=0:d=${FADE_DUR},fade=t=out:st=${Math.max(0, outDur - FADE_DUR).toFixed(3)}:d=${FADE_DUR}[vout]`
    );
  } else {
    let prev = "v0";
    let offset = durations[0];
    for (let i = 1; i < n; i++) {
      const out = i === n - 1 ? "vout" : `vx${i}`;
      parts.push(
        `[${prev}][v${i}]xfade=transition=fade:duration=${XFADE_DUR}:offset=${(offset - i * XFADE_DUR).toFixed(3)}[${out}]`
      );
      prev = out;
      offset += durations[i];
    }
    parts.push(
      `[vout]fade=t=in:st=0:d=${FADE_DUR},fade=t=out:st=${Math.max(0, outDur - FADE_DUR).toFixed(3)}:d=${FADE_DUR}[vfinal]`
    );
  }

  const videoOut = n === 1 ? "vout" : "vfinal";
  parts.push(`${audioRefs.join("")}concat=n=${n}:v=0:a=1[afinal]`);

  await execFileAsync("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", `[${videoOut}]`,
    "-map", "[afinal]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ]);
}

/**
 * 合成一集：所有有 videoPath 的镜头按 sequence 拼接
 * @param episodeId 集 ID
 * @param bgmMood 可选 BGM 情绪（storage/bgm/<mood>/ 素材库，无素材时跳过）
 */
export async function composeEpisode(
  episodeId: string,
  bgmMood?: string
): Promise<{ finalPath: string; subtitlePath: string | null; shots: number; duration: number }> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { shots: { orderBy: { sequence: "asc" } } },
  });
  if (!episode) throw new Error(`剧集不存在: ${episodeId}`);

  const shots = episode.shots.filter((s) => s.videoPath);
  if (shots.length === 0) throw new Error("本集还没有任何视频片段，请先生成视频");

  const clips: string[] = [];
  const clipDurations: number[] = []; // 与 clips 对齐：每镜最终 clip 时长（字幕偏移基准）
  const tmpFiles: string[] = [];
  let finalPath = "";
  let subtitleRel = "";

  try {
    // 1. 逐镜头生成 clip（混入配音）
    for (const shot of shots) {
      const video = absPath(shot.videoPath!);
      const { path: clipPath, relPath: clipRel } = uniqueName("clips", ".mp4");
      tmpFiles.push(clipPath);

      if (shot.voicePath) {
        const voice = absPath(shot.voicePath);
        await execFileAsync("ffmpeg", [
          "-y",
          "-i", video,
          "-i", voice,
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c:v", "copy",
          "-c:a", "aac", "-b:a", "192k",
          "-shortest",
          clipPath,
        ]);
      } else {
        // 无配音：保留视频原音轨（若有），否则静音
        await execFileAsync("ffmpeg", ["-y", "-i", video, "-c", "copy", clipPath]);
      }
      clips.push(clipRel);
      clipDurations.push(await probeDuration(clipRel));
    }

    // 2. 拼接成片：优先转场链（镜头叠化 + 首尾淡入淡出），失败降级 concat
    const finalName = uniqueName("videos", ".mp4");
    const finalRel = finalName.relPath;
    finalPath = finalName.path;

    try {
      await composeWithTransitions(clips, clipDurations, finalPath);
    } catch {
      const listPath = join(
        (await import("node:os")).tmpdir(),
        `concat-${episode.id}-${Date.now()}.txt`
      );
      tmpFiles.push(listPath);
      await writeFile(
        listPath,
        clips.map((c) => `file '${absPath(c)}'`).join("\n"),
        "utf8"
      );
      try {
        await execFileAsync("ffmpeg", [
          "-y", "-f", "concat", "-safe", "0",
          "-i", listPath,
          "-c", "copy",
          finalPath,
        ]);
      } catch {
        // 规格不一致（真实可灵片段）→ 重编码保证可拼接
        await execFileAsync("ffmpeg", [
          "-y", "-f", "concat", "-safe", "0",
          "-i", listPath,
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          finalPath,
        ]);
      }
    }

    let duration = await probeDuration(finalRel);

    // 3. 可选 BGM 混音（素材缺失时静默跳过）：输出到临时文件后原子替换成片
    if (bgmMood) {
      try {
        const music = await getMusic();
        const handle = await music.generate({ mood: bgmMood, duration });
        if (handle.status === "done" && handle.result?.audioPath) {
          const bgmPath = absPath(handle.result.audioPath);
          const { path: mixedPath } = uniqueName("videos", ".mp4");
          tmpFiles.push(mixedPath);
          await execFileAsync("ffmpeg", [
            "-y",
            "-i", finalPath,
            "-stream_loop", "-1",
            "-i", bgmPath,
            "-filter_complex",
            `[1:a]volume=0.22,atrim=0:${Math.ceil(duration)},asetpts=PTS-STARTPTS[b]`,
            "-map", "0:v",
            "-map", "[b]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            mixedPath,
          ]);
          await execFileAsync("ffmpeg", ["-y", "-i", mixedPath, "-c", "copy", finalPath]);
        }
      } catch {
        // BGM 不可用不阻断成片
      }
    }

    // 4. 字幕：汇总各镜字幕 → SRT 文件 → 烧录进成片（失败降级仅保留 SRT）
    const mergedCues: TTSSubtitle[] = [];
    let offset = 0;
    shots.forEach((shot, i) => {
      const rel = clipDurations[i] ?? 0;
      if (shot.subtitlePath) {
        try {
          const cues = JSON.parse(shot.subtitlePath) as TTSSubtitle[];
          if (Array.isArray(cues) && cues.length) {
            const base = offset * 1000;
            for (const c of cues) {
              mergedCues.push({ start: c.start + base, end: c.end + base, text: c.text });
            }
          }
        } catch {
          // 单镜字幕损坏不阻断
        }
      }
      offset += rel;
    });

    if (mergedCues.length > 0) {
      const srtContent = cuesToSrt(mergedCues);
      const vttContent = cuesToVtt(mergedCues);
      subtitleRel = finalRel.replace(/\.mp4$/, ".srt");
      await writeFile(absPath(subtitleRel), srtContent, "utf8");
      await writeFile(absPath(subtitleRel.replace(/\.srt$/, ".vtt")), vttContent, "utf8");
      // 烧录（需 ffmpeg 带 libass；精简构建自动跳过，播放器走 WebVTT 软字幕）
      if (await hasSubtitlesFilter()) {
        try {
          const { path: subPath } = uniqueName("videos", ".mp4");
          tmpFiles.push(subPath);
          const vf = [
            `subtitles='${escapeFilterPath(absPath(subtitleRel))}'`,
            `force_style='FontName=PingFang SC,FontSize=18,MarginV=30,Outline=1,OutlineColour=&H80000000,PrimaryColour=&H00FFFFFF,BorderStyle=1,Alignment=2'`,
          ].join(":");
          await execFileAsync("ffmpeg", [
            "-y",
            "-i", finalPath,
            "-vf", vf,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            subPath,
          ]);
          await execFileAsync("ffmpeg", ["-y", "-i", subPath, "-c", "copy", finalPath]);
        } catch {
          // 烧录失败（缺字体等）不阻断成片，SRT/VTT 文件保留
        }
      }
    }

    // 5. 回写 Episode
    await prisma.episode.update({
      where: { id: episodeId },
      data: { finalPath: finalRel, status: "composed" },
    });

    return { finalPath: finalRel, subtitlePath: subtitleRel || null, shots: shots.length, duration };
  } finally {
    // 清理临时 clip / concat list / BGM 中间产物（保留最终成片）
    for (const f of tmpFiles) {
      if (f.includes("concat-")) continue;
      if (finalPath && absPath(finalPath) === f) continue;
      await unlink(f).catch(() => {});
    }
  }
}
