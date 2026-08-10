/**
 * 供应商注册表 — 按配置路由到真实/Mock 实现，实例缓存
 * 使用方式：
 *   const llm = await getScriptLLM();   // 剧本创作（DeepSeek）
 *   const struct = await getStructLLM(); // 结构化任务（豆包）
 *   const image = await getImage();
 *   const video = await getVideo();
 *   const tts = await getTTS();
 */
import type {
  ImageProvider,
  LLMProvider,
  MusicProvider,
  SFXProvider,
  TTSProvider,
  VideoProvider,
} from "@/lib/providers/types";
import { getApiKey, getSetting, shouldUseMock } from "@/lib/providers/settings";
import { createDeepSeekProvider, createDoubaoProvider, createMockLLMProvider } from "@/lib/providers/llm";
import { createImageProvider } from "@/lib/providers/image";
import { createVideoProvider } from "@/lib/providers/video";
import { createTTSProvider } from "@/lib/providers/tts";
import { createMusicProvider } from "@/lib/providers/music";
import { createSfxProvider } from "@/lib/providers/sfx";

// ========== 实例缓存 ==========

const cache = new Map<string, unknown>();

async function cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    cache.set(key, await factory());
  }
  return cache.get(key) as T;
}

export function resetProviderCache(): void {
  cache.clear();
}

// ========== LLM（双路由） ==========

/** 剧本创作 LLM（默认 DeepSeek） */
export async function getScriptLLM(): Promise<LLMProvider> {
  return cached("llm:script", async () => {
    const providerId = (await getSetting("llm.scriptProvider")) ?? "deepseek";
    if (providerId === "deepseek") {
      const mock = await shouldUseMock("deepseek");
      return mock ? createMockLLMProvider() : createDeepSeekProvider();
    }
    if (providerId === "doubao") {
      const mock = await shouldUseMock("doubao");
      return mock ? createMockLLMProvider() : createDoubaoProvider();
    }
    return createMockLLMProvider();
  });
}

/** 结构化任务 LLM（默认豆包） */
export async function getStructLLM(): Promise<LLMProvider> {
  return cached("llm:struct", async () => {
    const providerId = (await getSetting("llm.structProvider")) ?? "doubao";
    if (providerId === "doubao") {
      const mock = await shouldUseMock("doubao");
      return mock ? createMockLLMProvider() : createDoubaoProvider();
    }
    if (providerId === "deepseek") {
      const mock = await shouldUseMock("deepseek");
      return mock ? createMockLLMProvider() : createDeepSeekProvider();
    }
    return createMockLLMProvider();
  });
}

// ========== 图像 ==========

export async function getImage(): Promise<ImageProvider> {
  return cached("image", async () => {
    const providerId = (await getSetting("image.provider")) ?? "seedream";
    const mock = providerId === "seedream" ? await shouldUseMock("ark") : false;
    return createImageProvider(mock ? "mock" : providerId);
  });
}

// ========== 视频 ==========

export async function getVideo(): Promise<VideoProvider> {
  return cached("video", async () => {
    const providerId = (await getSetting("video.provider")) ?? "kling";
    if (providerId === "kling") {
      // 可灵需要 AK + SK 双凭证
      const mode = (await getSetting("mock.mode")) ?? "auto";
      const key = await getApiKey("kling");
      const secret = await getSetting("kling.secret");
      if (mode === "auto" && (!key || !secret)) {
        return createVideoProvider("mock");
      }
      if (mode === "true") return createVideoProvider("mock");
    }
    return createVideoProvider(providerId);
  });
}

// ========== TTS ==========

export async function getTTS(): Promise<TTSProvider> {
  return cached("tts", async () => {
    const providerId = (await getSetting("tts.provider")) ?? "cosyvoice";
    if (providerId === "cosyvoice") {
      const mock = await shouldUseMock("dashscope");
      return mock ? createTTSProvider("mock") : createTTSProvider("cosyvoice");
    }
    return createTTSProvider(providerId);
  });
}

// ========== 音乐 / 音效 ==========

export async function getMusic(): Promise<MusicProvider> {
  return cached("music", () => createMusicProvider());
}

export async function getSFX(): Promise<SFXProvider> {
  return cached("sfx", () => createSfxProvider());
}
