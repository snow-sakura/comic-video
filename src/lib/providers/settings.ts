/**
 * 供应商配置中心
 * - 读取优先级：DB (ProviderSetting) > 环境变量 > 默认值
 * - 设置页写入 DB；Key 类敏感信息仅存 DB 明文（本地工具）+ env
 */
import { prisma } from "@/lib/db";
import { loadEnv } from "@/lib/env";

loadEnv();

// ========== 默认配置 ==========

const DEFAULTS = {
  // LLM 路由：script=剧本创作用 | struct=结构化任务用
  "llm.scriptProvider": "deepseek",
  "llm.structProvider": "doubao",
  "llm.deepseek.model": "deepseek-chat",
  "llm.doubao.model": "doubao-seed-1-6-250615",
  // 图像
  "image.provider": "seedream",
  "image.seedream.model": "doubao-seedream-5-0-pro-260628",
  // 视频
  "video.provider": "kling",
  "video.kling.model": "kling-v3-0-omni",
  // TTS
  "tts.provider": "cosyvoice",
  "tts.cosyvoice.model": "cosyvoice-v2",
} as const;

export type SettingKey = keyof typeof DEFAULTS | string;

// ========== 读取 ==========

const cache = new Map<string, string>();
let cacheLoaded = false;

async function loadAllFromDb(): Promise<void> {
  if (cacheLoaded) return;
  try {
    const rows = await prisma.providerSetting.findMany();
    for (const row of rows) cache.set(row.key, row.value);
  } catch {
    // DB 不可用时退回环境变量
  }
  cacheLoaded = true;
}

function envMap(key: string): string | undefined {
  const envKey = key.replaceAll(".", "_").toUpperCase();
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
  cache.clear();
}

// ========== Key 获取辅助 ==========

export async function getApiKey(platform: string): Promise<string | undefined> {
  return getSetting<string>(`${platform}.apiKey`);
}

export function getApiKeySync(platform: string): string | undefined {
  return getSettingSync<string>(`${platform}.apiKey`);
}

// ========== Mock 模式判定 ==========

/**
 * MOCK_MODE: auto=有Key用真、无Key自动mock | true=强制mock | false=强制真实
 */
export async function shouldUseMock(platform: string): Promise<boolean> {
  const mode = await getSetting<string>("mock.mode");
  if (mode === "true") return true;
  if (mode === "false") return false;
  const key = await getApiKey(platform);
  return !key;
}

export function shouldUseMockSync(platform: string): boolean {
  const mode = getSettingSync<string>("mock.mode");
  if (mode === "true") return true;
  if (mode === "false") return false;
  return !getApiKeySync(platform);
}
