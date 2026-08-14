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

const _execFileAsync = promisify(execFile);
/** ffmpeg 超时保护：5 分钟（300s）无输出则强制终止 */
const FFMPEG_TIMEOUT = 300_000;
const execFileAsync = (file: string, args: string[], options?: object) =>
  _execFileAsync(file, args, { timeout: FFMPEG_TIMEOUT, ...options });

/**
 * ffmpeg 二进制选择：
 * 1. FFMPEG_BIN 环境变量显式指定
 * 2. ffmpeg-full（homebrew-ffmpeg tap，带 libass/freetype 全功能构建）
 * 3. ffmpeg（系统默认，精简构建可能无 subtitles/drawtext 滤镜）
 */
let ffmpegBinCache: string | undefined;
export function ffmpegBin(): string {
  if (ffmpegBinCache !== undefined) return ffmpegBinCache;
  ffmpegBinCache = process.env.FFMPEG_BIN ?? "ffmpeg";
  return ffmpegBinCache;
}

let ffprobeBinCache: string | undefined;
export function ffprobeBin(): string {
  if (ffprobeBinCache !== undefined) return ffprobeBinCache;
  ffprobeBinCache = process.env.FFPROBE_BIN ?? "ffprobe";
  return ffprobeBinCache;
}

/** subtitles 滤镜可用性（ffmpeg 精简构建可能无 libass），首次探测后缓存 */
let hasSubtitlesFilterCache: boolean | null = null;
async function hasSubtitlesFilter(): Promise<boolean> {
  if (hasSubtitlesFilterCache !== null) return hasSubtitlesFilterCache;
  try {
    const { stdout } = await execFileAsync(ffmpegBin(), ["-hide_banner", "-filters"]);
    hasSubtitlesFilterCache = stdout.split("\n").some((l) => /subtitles|ass\s/.test(l));
  } catch {
    hasSubtitlesFilterCache = false;
  }
  return hasSubtitlesFilterCache;
}

// ========== drawtext 字幕烧录（无 libass 时的兜底方案，逐句绘制） ==========

/** drawtext 滤镜可用性，首次探测后缓存 */
let hasDrawtextFilterCache: boolean | null = null;
async function hasDrawtextFilter(): Promise<boolean> {
  if (hasDrawtextFilterCache !== null) return hasDrawtextFilterCache;
  try {
    const { stdout } = await execFileAsync(ffmpegBin(), ["-hide_banner", "-filters"]);
    hasDrawtextFilterCache = stdout.split("\n").some((l) => /drawtext\s/.test(l));
  } catch {
    hasDrawtextFilterCache = false;
  }
  return hasDrawtextFilterCache;
}

/** 中文字体探测：依次尝试常见字体文件，首个存在者返回 */
const CJK_FONT_CANDIDATES = [
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
];

let cjkFontCache: string | null | undefined;
async function detectCjkFont(): Promise<string | null> {
  if (cjkFontCache !== undefined) return cjkFontCache;
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      await import("node:fs").then((fs) => fs.promises.access(p));
      cjkFontCache = p;
      return p;
    } catch {
      // 尝试下一个
    }
  }
  cjkFontCache = null;
  return null;
}

/** 候选 CJK 字体族名（key 与 CJK_FONT_CANDIDATES 对齐，fc-match 失败时回退） */
const CJK_FONT_NAME_BY_FILE: Record<string, string> = {
  "/System/Library/Fonts/STHeiti Light.ttc": "Heiti SC",
  "/System/Library/Fonts/Hiragino Sans GB.ttc": "Hiragino Sans GB",
  "/System/Library/Fonts/PingFang.ttc": "PingFang SC",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf": "Arial Unicode MS",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc": "Noto Sans CJK SC",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc": "WenQuanYi Micro Hei",
};

let cjkFontNameCache: string | null | undefined;

/**
 * libass (subtitles 滤镜) 可用的 CJK 字体族名。
 * 注意：FontName 必须是 fontconfig 实际可解析的族名（如 "Heiti SC"），
 * 写死 "PingFang SC" 在无该字体的机器上会静默渲染空白。
 */
async function detectCjkFontName(): Promise<string | null> {
  if (cjkFontNameCache !== undefined) return cjkFontNameCache;
  try {
    const { stdout } = await execFileAsync("fc-match", ["-f", "%{family}", "sans-serif:lang=zh"]);
    const name = String(stdout).trim().split(",")[0]?.trim();
    if (name) {
      cjkFontNameCache = name;
      return name;
    }
  } catch {
    // fc-match 不可用，走候选表回退
  }
  const file = await detectCjkFont();
  cjkFontNameCache = (file && CJK_FONT_NAME_BY_FILE[file]) || null;
  return cjkFontNameCache;
}

/** drawtext 文本转义：过滤特殊字符，避免破坏滤镜语法 */
function drawtextEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ");
}

/** 按中文宽度断行：每行 maxChars 字（按全角字符估算），返回插入 \n 的文本 */
function wrapText(text: string, maxChars = 16): string {
  const out: string[] = [];
  let line = "";
  let count = 0;
  for (const ch of text) {
    const w = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.5;
    if (count + w > maxChars && line) {
      out.push(line);
      line = ch;
      count = w;
    } else {
      line += ch;
      count += w;
    }
  }
  if (line) out.push(line);
  return out.join("\n");
}

/** 用 drawtext 滤镜链把字幕烧录进成片（输出到 subPath），失败返回 false */
async function burnWithDrawtext(finalPath: string, mergedCues: TTSSubtitle[], subPath: string): Promise<boolean> {
  const fontFile = await detectCjkFont();
  if (!fontFile) return false;
  // 1080p 基准 22px；视频高度 <700 时缩小到 18px
  const fontsize = 22;
  try {
    const filters = mergedCues.map((c) => {
      const t = drawtextEscape(wrapText(c.text));
      const start = Math.max(0, c.start / 1000);
      const dur = Math.max(0.4, (c.end - c.start) / 1000);
      return (
        `drawtext=fontfile=${fontFile}:` +
        `text='${t}':` +
        `x=(w-text_w)/2:y=h-64:` +
        `fontsize=${fontsize}:fontcolor=white:` +
        `borderw=2:bordercolor=black@0.75:` +
        `line_spacing=6:` +
        `enable='between(t,${start.toFixed(2)},${(start + dur).toFixed(2)})'`
      );
    });
    await execFileAsync(ffmpegBin(), [
      "-y",
      "-i", finalPath,
      "-vf", filters.join(","),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      subPath,
    ]);
    await execFileAsync(ffmpegBin(), ["-y", "-i", subPath, "-c", "copy", finalPath]);
    return true;
  } catch {
    return false;
  }
}

/** 按相对路径读取媒体文件时长（ffprobe，秒） */
async function probeDuration(relPath: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobeBin(), [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    absPath(relPath),
  ]);
  const n = parseFloat(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`无法解析媒体时长: ${relPath}`);
  return n;
}

/** 读取视频主分辨率（不存在时抛错） */
async function probeVideoSize(relPath: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync(ffprobeBin(), [
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
    const { stdout } = await execFileAsync(ffprobeBin(), [
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
  // 音频 concat 全长会超过视频（xfade 有叠化损耗），atrim 对齐到 outDur 避免尾部静音
  parts.push(
    `${audioRefs.join("")}concat=n=${n}:v=0:a=1,atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[afinal]`
  );

  await execFileAsync(ffmpegBin(), [
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
        // 探测两端时长：配音长于视频时用 tpad 补帧延长画面（否则 -shortest 会截断视频丢画面）
        let needPad = false;
        let padDiff = 0;
        try {
          const [videoDur, voiceDur] = await Promise.all([
            probeDuration(shot.videoPath!),
            probeDuration(shot.voicePath!),
          ]);
          padDiff = voiceDur - videoDur;
          needPad = padDiff > 0.2;
        } catch {
          // 探测失败走原逻辑（apad + -shortest）
        }
        if (needPad) {
          await execFileAsync(ffmpegBin(), [
            "-y",
            "-i", video,
            "-i", voice,
            "-filter_complex",
            `[0:v]tpad=stop_mode=clone:stop_duration=${padDiff.toFixed(3)}[v];[1:a]apad[a]`,
            "-map", "[v]",
            "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            clipPath,
          ]);
        } else {
          // 配音短于视频时用 apad 补静音，保证画面完整（-shortest 会截断视频丢帧）
          await execFileAsync(ffmpegBin(), [
            "-y",
            "-i", video,
            "-i", voice,
            "-filter_complex", "[1:a]apad[a]",
            "-map", "0:v:0",
            "-map", "[a]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            clipPath,
          ]);
        }
      } else {
        // 无配音：保留视频原音轨（若有），否则静音
        await execFileAsync(ffmpegBin(), ["-y", "-i", video, "-c", "copy", clipPath]);
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
    } catch (e) {
      console.error(`[compose] 转场链失败，降级 concat: ${e instanceof Error ? e.message : String(e)}`);
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
        await execFileAsync(ffmpegBin(), [
          "-y", "-f", "concat", "-safe", "0",
          "-i", listPath,
          "-c", "copy",
          finalPath,
        ]);
      } catch {
        // 规格不一致（真实可灵片段）→ 重编码保证可拼接
        await execFileAsync(ffmpegBin(), [
          "-y", "-f", "concat", "-safe", "0",
          "-i", listPath,
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          finalPath,
        ]);
      }
    }

    const duration = await probeDuration(finalRel);

    // 3. 可选 BGM 混音（素材缺失时静默跳过）：输出到临时文件后原子替换成片
    if (bgmMood) {
      try {
        const music = await getMusic();
        const handle = await music.generate({ mood: bgmMood, duration });
        if (handle.status === "done" && handle.result?.audioPath) {
          const bgmPath = absPath(handle.result.audioPath);
          const { path: mixedPath } = uniqueName("videos", ".mp4");
          tmpFiles.push(mixedPath);
          await execFileAsync(ffmpegBin(), [
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
          await execFileAsync(ffmpegBin(), ["-y", "-i", mixedPath, "-c", "copy", finalPath]);
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
            // xfade 链实际时间轴：第 i 段 (i>0) 起始比 concat 累计提前 i×XFADE_DUR
            const base = (offset - (i > 0 ? i * XFADE_DUR : 0)) * 1000;
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
      // 烧录：优先 libass subtitles 滤镜；无 libass 时用 drawtext 逐句绘制兜底；都失败则保留 SRT/VTT 软字幕
      if (await hasSubtitlesFilter()) {
        const fontName = await detectCjkFontName();
        if (fontName) {
          try {
            const { path: subPath } = uniqueName("videos", ".mp4");
            tmpFiles.push(subPath);
            const subAbs = absPath(subtitleRel);
            const vf = [
              `subtitles=${subAbs}`,
              `force_style='FontName=${fontName},FontSize=18,MarginV=30,Outline=1,OutlineColour=&H80000000,PrimaryColour=&H00FFFFFF,BorderStyle=1,Alignment=2'`,
            ].join(":");
            await execFileAsync(ffmpegBin(), [
              "-y",
              "-i", finalPath,
              "-vf", vf,
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
              "-c:a", "copy",
              subPath,
            ]);
            await execFileAsync(ffmpegBin(), ["-y", "-i", subPath, "-c", "copy", finalPath]);
          } catch {
            // 烧录失败（缺字体等）不阻断成片，SRT/VTT 文件保留
          }
        }
      } else if (await hasDrawtextFilter()) {
        const { path: subPath } = uniqueName("videos", ".mp4");
        tmpFiles.push(subPath);
        await burnWithDrawtext(finalPath, mergedCues, subPath);
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
