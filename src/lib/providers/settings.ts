/**
 * 供应商配置中心
 *
 * 设计原则（务必遵守）：
 *  - 配置按「能力类别」分组：text / image / video / tts，每类只读自己的 `<类别>.*` 配置，
 *    绝不跨类读取（文本模型不会误读图片模型，反之亦然）。
 *  - 配置键 `<类别>.<字段>` 与环境变量 `<大写类别>_<大写字段>` 一一对应：
 *      text.apiKey   → TEXT_API_KEY
 *      text.model    → TEXT_MODEL
 *      image.model   → IMAGE_MODEL
 *      video.model   → VIDEO_MODEL
 *      tts.engine    → TTS_ENGINE
 *      tts.voice     → TTS_VOICE
 *      mock.mode     → MOCK_MODE
 *  - 读取优先级：DB (ProviderSetting) > 环境变量 > 默认值
 *  - 设置页写入 DB；Key 类敏感信息仅存 DB 明文（本地工具）+ env
 */
import { prisma } from "@/lib/db";
import { loadEnv } from "@/lib/env";

loadEnv();

// ========== 默认配置 ==========

const ZHIPU_BASE = "https://open.bigmodel.cn/api/paas/v4";

const DEFAULTS = {
  // Mock 模式：auto=有Key用真、无Key自动mock | true=强制mock | false=强制真实
  "mock.mode": "auto",

  // 文本（LLM）：glm=智谱清言(默认) | deepseek | doubao | mock
  "text.provider": "glm",
  "text.model": "glm-4.7-flash",
  "text.baseUrl": ZHIPU_BASE,

  // 图像：cogview=智谱CogView(默认) | seedream=火山方舟 | mock
  "image.provider": "cogview",
  "image.model": "cogview-3-flash",
  "image.baseUrl": ZHIPU_BASE,

  // 视频：cogvideox=智谱CogVideoX(默认) | kling=可灵 | mock
  "video.provider": "cogvideox",
  "video.model": "cogvideox-flash",
  "video.baseUrl": ZHIPU_BASE,

  // TTS（预留：未配置 engine 时走 Mock；配置 TTS_ENGINE 后即可直接使用）
  // engine: edge-tts(微软,免费无Key) | cosyvoice(阿里百炼) | mock
  "tts.engine": "",
  "tts.model": "",
  "tts.voice": "",
  "tts.baseUrl": "",
} as const;

export type SettingKey = keyof typeof DEFAULTS | string;

// ========== 类型化分类配置 ==========

export interface TextConfig {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl: string;
}
export interface ImageConfig {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl: string;
}
export interface VideoConfig {
  provider: string;
  apiKey?: string;
  secret?: string; // 仅可灵需要
  model: string;
  baseUrl: string;
}
export interface TTSConfig {
  engine: string; // 空 = 未配置 → Mock
  apiKey?: string;
  model?: string;
  voice?: string;
  baseUrl?: string;
}

// ========== 读取 ==========

const cache = new Map<string, string>();
let cacheLoaded = false;
let cacheLoadedAt = 0; // 上次加载时间戳
const CACHE_TTL = 60_000; // 缓存有效期 60 秒

async function loadAllFromDb(): Promise<void> {
  const now = Date.now();
  if (cacheLoaded && now - cacheLoadedAt < CACHE_TTL) return;
  try {
    const rows = await prisma.providerSetting.findMany();
    cache.clear();
    for (const row of rows) cache.set(row.key, row.value);
  } catch {
    // DB 不可用时退回环境变量
  }
  cacheLoaded = true;
  cacheLoadedAt = now;
}

function envMap(key: string): string | undefined {
  // video.apiKey → VIDEO_API_KEY（点转下划线 + 驼峰转下划线，全大写）
  const envKey = key
    .replaceAll(".", "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
  const val = process.env[envKey];
  return val || undefined;
}

/** 读取配置（DB > env > 默认） */
export async function getSetting<T = string>(key: SettingKey): Promise<T | undefined> {
  await loadAllFromDb();
  const fromDb = cache.get(key);
  if (fromDb !== undefined) return fromDb as T;
  const fromEnv = envMap(key);
  if (fromEnv !== undefined) return fromEnv as T;
  const def = (DEFAULTS as Record<string, string>)[key];
  return (def as T) ?? undefined;
}

/** 同步读取（env/默认，不查 DB；用于无 DB 依赖的场景） */
export function getSettingSync<T = string>(key: SettingKey): T | undefined {
  const fromEnv = envMap(key);
  if (fromEnv !== undefined) return fromEnv as T;
  const def = (DEFAULTS as Record<string, string>)[key];
  return (def as T) ?? undefined;
}

// ========== 分类配置读取助手（各类只读自己，杜绝混读） ==========

/** 文本模型配置（仅读 text.*） */
export async function getTextConfig(): Promise<TextConfig> {
  return {
    provider: (await getSetting<string>("text.provider")) ?? "glm",
    apiKey: await getSetting<string>("text.apiKey"),
    model: (await getSetting<string>("text.model")) ?? "glm-4.7-flash",
    baseUrl: (await getSetting<string>("text.baseUrl")) ?? ZHIPU_BASE,
  };
}

/** 图像模型配置（仅读 image.*） */
export async function getImageConfig(): Promise<ImageConfig> {
  return {
    provider: (await getSetting<string>("image.provider")) ?? "cogview",
    apiKey: await getSetting<string>("image.apiKey"),
    model: (await getSetting<string>("image.model")) ?? "cogview-3-flash",
    baseUrl: (await getSetting<string>("image.baseUrl")) ?? ZHIPU_BASE,
  };
}

/** 视频模型配置（仅读 video.*） */
export async function getVideoConfig(): Promise<VideoConfig> {
  return {
    provider: (await getSetting<string>("video.provider")) ?? "cogvideox",
    apiKey: await getSetting<string>("video.apiKey"),
    secret: await getSetting<string>("video.secret"),
    model: (await getSetting<string>("video.model")) ?? "cogvideox-flash",
    baseUrl: (await getSetting<string>("video.baseUrl")) ?? ZHIPU_BASE,
  };
}

/** TTS 配置（仅读 tts.*；engine 为空表示未配置） */
export async function getTTSConfig(): Promise<TTSConfig> {
  return {
    engine: (await getSetting<string>("tts.engine")) ?? "",
    apiKey: await getSetting<string>("tts.apiKey"),
    model: await getSetting<string>("tts.model"),
    voice: await getSetting<string>("tts.voice"),
    // 兼容两种写法：TTS_BASE_URL（DB: tts.baseUrl）优先，TTS_API_URL 次之
    baseUrl:
      (await getSetting<string>("tts.baseUrl")) ||
      process.env.TTS_API_URL ||
      undefined,
  };
}

// ========== 写入 ==========

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.providerSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  cache.set(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  await prisma.providerSetting.delete({ where: { key } }).catch(() => {});
  cache.delete(key);
}

/** 获取全部配置（设置页展示） */
export async function getAllSettings(): Promise<Record<string, string>> {
  await loadAllFromDb();
  const result: Record<string, string> = {};
  for (const [k, v] of cache) result[k] = v;
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in result)) result[key] = (DEFAULTS as Record<string, string>)[key];
  }
  return result;
}

/** 重置缓存（设置页保存后调用） */
export function invalidateSettingCache(): void {
  cacheLoaded = false;
  cacheLoadedAt = 0;
  cache.clear();
}

// ========== Key 获取辅助（兼容旧调用方） ==========

export async function getApiKey(platform: string): Promise<string | undefined> {
  return getSetting<string>(`${platform}.apiKey`);
}

export function getApiKeySync(platform: string): string | undefined {
  return getSettingSync<string>(`${platform}.apiKey`);
}

/** 脱敏 API Key 用于日志输出（保留首尾各 4 位，过短则全掩码） */
export function maskKey(key?: string): string {
  if (!key) return "(未配置)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 计时器：调用返回当前已耗时毫秒数，用于网络请求耗时统计 */
export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}

// ========== Mock 模式判定 ==========

export type ProviderCategory = "text" | "image" | "video" | "tts";

/**
 * MOCK_MODE: auto=有Key用真、无Key自动mock | true=强制mock | false=强制真实
 * 按能力类别判定：各类只看自己的凭证，互不干扰。
 */
export async function shouldUseMock(category: ProviderCategory): Promise<boolean> {
  const mode = (await getSetting<string>("mock.mode")) ?? "auto";
  if (mode === "true") return true;
  if (mode === "false") return false;
  // auto：依据各类自身凭证判定
  if (category === "tts") {
    const engine = (await getSetting<string>("tts.engine")) ?? "";
    if (!engine) return true; // 未配置引擎 → Mock
    if (engine === "edge-tts" || engine === "confucius4") return false; // 免费引擎无需 Key
    const key = await getSetting<string>("tts.apiKey");
    return !key;
  }
  if (category === "video") {
    // 可灵需 AK + SK 双凭证；其余只需 apiKey
    const provider = (await getSetting<string>("video.provider")) ?? "cogvideox";
    const apiKey = await getSetting<string>("video.apiKey");
    if (!apiKey) return true;
    if (provider === "kling") {
      const secret = await getSetting<string>("video.secret");
      return !secret;
    }
    return false;
  }
  const key = await getSetting<string>(`${category}.apiKey`);
  return !key;
}

export function shouldUseMockSync(category: ProviderCategory): boolean {
  const mode = getSettingSync<string>("mock.mode") ?? "auto";
  if (mode === "true") return true;
  if (mode === "false") return false;
  if (category === "tts") {
    const engine = getSettingSync<string>("tts.engine") ?? "";
    if (!engine) return true;
    if (engine === "edge-tts") return false;
    return !getApiKeySync("tts");
  }
  if (category === "video") {
    const provider = getSettingSync<string>("video.provider") ?? "cogvideox";
    if (!getApiKeySync("video")) return true;
    if (provider === "kling") return !getSettingSync<string>("video.secret");
    return false;
  }
  return !getApiKeySync(category);
}
