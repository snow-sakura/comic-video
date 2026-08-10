/**
 * 音效供应商实现：本地 SFX 素材库（按标签子目录索引）
 * storage/sfx/<tag>/ 下放置音效文件；AI 音效生成能力预留。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SFXEntry, SFXProvider } from "@/lib/providers/types";
import { getSetting } from "@/lib/providers/settings";
import { absPath, getCategoryDir } from "@/lib/storage";

export const SFX_PROVIDER_ID = "sfx-library";

const AUDIO_EXT = /\.(mp3|wav|m4a|flac|ogg)$/i;

export function createSfxLibraryProvider(): SFXProvider {
  return {
    id: SFX_PROVIDER_ID,
    displayName: "本地音效素材库",

    async search(tags: string[]): Promise<SFXEntry[]> {
      const sfxRoot = (await getSetting<string>("sfx.dir")) ?? getCategoryDir("sfx");
      const root = absPath(sfxRoot);
      const results: SFXEntry[] = [];

      // 素材结构: storage/sfx/<tag>/<file> 或 storage/sfx/<file>
      try {
        const topLevel = await readdir(root, { withFileTypes: true });
        for (const entry of topLevel) {
          if (entry.isDirectory()) {
            const tag = entry.name;
            if (tags.length > 0 && !tags.some((t) => tag.includes(t) || t.includes(tag))) {
              continue;
            }
            const files = await readdir(join(root, entry.name));
            for (const f of files) {
              if (AUDIO_EXT.test(f)) {
                results.push({
                  path: join(root, entry.name, f),
                  label: f.replace(AUDIO_EXT, ""),
                  tags: [tag],
                });
              }
            }
          } else if (AUDIO_EXT.test(entry.name)) {
            results.push({
              path: join(root, entry.name),
              label: entry.name.replace(AUDIO_EXT, ""),
              tags: [],
            });
          }
        }
      } catch {
        // 目录不存在：返回空列表，UI 提示用户放置素材
        return [];
      }

      // 多标签命中优先排序
      if (tags.length > 1) {
        results.sort((a, b) => b.tags.length - a.tags.length);
      }
      return results.slice(0, 50);
    },
  };
}

export async function createSfxProvider(id?: string): Promise<SFXProvider> {
  const providerId = id ?? (await getSetting<string>("sfx.provider")) ?? SFX_PROVIDER_ID;
  if (providerId === SFX_PROVIDER_ID) return createSfxLibraryProvider();
  return createSfxLibraryProvider();
}
