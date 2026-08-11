/**
 * 音乐供应商实现：本地 BGM 素材库（按情绪标签索引）+ AI 生成预留位
 * 国内可用的 AI 音乐 API（音疯 minimax 等）需企业资质，未接入；
 * 默认从 storage/bgm/<mood>/ 目录读取 BGM 素材，无素材时返回 Mock 提示。
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MusicGenerateOptions, MusicProvider, TaskHandle } from "@/lib/providers/types";
import { providerError } from "@/lib/providers/types";
import { getSetting } from "@/lib/providers/settings";
import { absPath, getCategoryDir } from "@/lib/storage";

export const MUSIC_PROVIDER_ID = "bgm-library";

/** 情绪 → 目录名映射（storage/bgm/ 下建子目录） */
const MOOD_DIRS: Record<string, string> = {
  tension: "tension",
  warmth: "warmth",
  mystery: "mystery",
  sadness: "sadness",
  excitement: "excitement",
  humor: "humor",
  romance: "romance",
  epic: "epic",
  calm: "calm",
  horror: "horror",
};

export function createBgmLibraryProvider(): MusicProvider {
  return {
    id: MUSIC_PROVIDER_ID,
    displayName: "本地 BGM 素材库",

    async generate(opts: MusicGenerateOptions): Promise<TaskHandle<{ audioPath: string }>> {
      const bgmRoot = (await getSetting<string>("music.bgmDir")) ?? getCategoryDir("bgm");
      const moodDirName = MOOD_DIRS[opts.mood] ?? "calm";
      const moodDir = join(absPath(bgmRoot), moodDirName);

      // 目录不存在或为空 → 提示用户放置素材
      try {
        const entries = await readdir(moodDir);
        const audioFiles = entries.filter((f) => /\.(mp3|wav|m4a|flac|ogg)$/i.test(f));
        if (audioFiles.length === 0) {
          throw providerError(
            "bgm-library",
            `BGM 素材库 ${moodDir} 为空，请放入 ${moodDirName} 情绪的音频文件`,
            "MOCK_UNAVAILABLE",
            false
          );
        }
        // 简单策略：取与目标时长最接近的文件；后续版本做节选/循环拼接
        let best = audioFiles[0];
        let bestDiff = Infinity;
        for (const f of audioFiles) {
          const p = join(moodDir, f);
          const s = await stat(p);
          const dur = s.size / 32000; // 粗略按 128kbps 估算时长
          const diff = Math.abs(dur - opts.duration);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = f;
          }
        }
        const audioPath = join(moodDir, best);
        return { taskId: `bgm-${Date.now()}`, status: "done", result: { audioPath } };
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as { code: string }).code === "MOCK_UNAVAILABLE") {
          throw e;
        }
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw providerError(
            "bgm-library",
            `BGM 素材库目录不存在：${moodDir}，请创建并放入音频文件`,
            "MOCK_UNAVAILABLE",
            false
          );
        }
        throw e;
      }
    },
  };
}

/** AI 生成预留（未来接入音疯/minimax 等 API 时实现） */
export function createAiMusicProvider(): MusicProvider {
  return {
    id: "ai-music",
    displayName: "AI 音乐生成（未接入）",
    async generate(): Promise<TaskHandle<{ audioPath: string }>> {
      throw providerError(
        "ai-music",
        "AI 音乐生成尚未接入（音疯 API 需企业资质），请使用本地 BGM 素材库模式",
        "MOCK_UNAVAILABLE",
        false
      );
    },
  };
}

export async function createMusicProvider(id?: string): Promise<MusicProvider> {
  const providerId = id ?? (await getSetting<string>("music.provider")) ?? MUSIC_PROVIDER_ID;
  if (providerId === MUSIC_PROVIDER_ID) return createBgmLibraryProvider();
  if (providerId === "ai-music") return createAiMusicProvider();
  return createBgmLibraryProvider();
}
