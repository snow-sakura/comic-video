/**
 * 供应商注册表 — 按配置路由到真实/Mock 实现，实例缓存
 *
 * 配置按能力类别分组，各类只读自己的 <类别>.* 配置，互不混读：
 *   const llm   = await getTextLLM();    // 文本模型（智谱 GLM 等）
 *   const image = await getImage();      // 图像模型（智谱 CogView 等）
 *   const video = await getVideo();      // 视频模型（智谱 CogVideoX 等）
 *   const tts   = await getTTS();        // 声音模型（edge-tts / cosyvoice，未配置走 Mock）
 *
 * 向后兼容：getScriptLLM / getStructLLM 均委托给 getTextLLM（统一使用文本模型）。
 */
import type {
  ImageProvider,
  LLMProvider,
  MusicProvider,
  SFXProvider,
  TTSProvider,
  VideoProvider,
} from "@/lib/providers/types";
import { getTextConfig, getImageConfig, getVideoConfig, getTTSConfig, shouldUseMock } from "@/lib/providers/settings";
import { createDeepSeekProvider, createDoubaoProvider, createGlmProvider, createMockLLMProvider } from "@/lib/providers/llm";
import { createCogViewProvider, createMockImageProvider, createSeedreamProvider } from "@/lib/providers/image";
import { createCogVideoXProvider, createKlingProvider, createMockVideoProvider } from "@/lib/providers/video";
import { createEdgeTTSProvider, createCosyVoiceProvider, createMockTTSProvider } from "@/lib/providers/tts";
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

// ========== 文本（LLM） ==========

/** 文本模型（默认智谱 GLM；按 text.provider 选择后端） */
export async function getTextLLM(): Promise<LLMProvider> {
  return cached("llm:text", async () => {
    const cfg = await getTextConfig();
    if (cfg.provider === "mock") return createMockLLMProvider();
    if (await shouldUseMock("text")) return createMockLLMProvider();
    switch (cfg.provider) {
      case "glm": return createGlmProvider();
      case "deepseek": return createDeepSeekProvider();
      case "doubao": return createDoubaoProvider();
      default: return createMockLLMProvider();
    }
  });
}

/** 剧本创作 LLM（向后兼容：委托给文本模型） */
export function getScriptLLM(): Promise<LLMProvider> {
  return getTextLLM();
}

/** 结构化任务 LLM（向后兼容：委托给文本模型） */
export function getStructLLM(): Promise<LLMProvider> {
  return getTextLLM();
}

// ========== 图像 ==========

export async function getImage(): Promise<ImageProvider> {
  return cached("image", async () => {
    const cfg = await getImageConfig();
    if (cfg.provider === "mock") return createMockImageProvider();
    if (await shouldUseMock("image")) return createMockImageProvider();
    switch (cfg.provider) {
      case "cogview": return createCogViewProvider();
      case "seedream": return createSeedreamProvider();
      default: return createMockImageProvider();
    }
  });
}

// ========== 视频 ==========

export async function getVideo(): Promise<VideoProvider> {
  return cached("video", async () => {
    const cfg = await getVideoConfig();
    if (cfg.provider === "mock") return createMockVideoProvider();
    if (await shouldUseMock("video")) return createMockVideoProvider();
    switch (cfg.provider) {
      case "cogvideox": return createCogVideoXProvider();
      case "kling": return createKlingProvider();
      default: return createMockVideoProvider();
    }
  });
}

// ========== TTS（声音模型；未配置 engine 时走 Mock） ==========

export async function getTTS(): Promise<TTSProvider> {
  return cached("tts", async () => {
    const cfg = await getTTSConfig();
    if (!cfg.engine) return createMockTTSProvider();
    if (await shouldUseMock("tts")) return createMockTTSProvider();
    switch (cfg.engine) {
      case "edge-tts": return createEdgeTTSProvider();
      case "cosyvoice": return createCosyVoiceProvider();
      default: return createMockTTSProvider();
    }
  });
}

// ========== 音乐 / 音效 ==========

export async function getMusic(): Promise<MusicProvider> {
  return cached("music", () => createMusicProvider());
}

export async function getSFX(): Promise<SFXProvider> {
  return cached("sfx", () => createSfxProvider());
}
