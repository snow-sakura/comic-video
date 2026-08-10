/**
 * 供应商适配器层 — 统一契约
 * 所有 AI 供应商实现以下接口，registry 按配置路由。
 * 每个适配器必须支持 mock 模式（无 Key 时占位实现，保证全流程可跑通）。
 */

// ========== 通用 ==========

export type ProviderId = string;

export interface ProviderConfig {
  /** 是否启用 */
  enabled: boolean;
  /** API Key */
  apiKey?: string;
  /** 额外配置（secret, baseUrl, model 等） */
  [key: string]: unknown;
}

export type TaskStatus = "queued" | "processing" | "done" | "failed";

export interface TaskHandle<T = unknown> {
  /** 本地任务 ID */
  taskId: string;
  /** 平台侧任务 ID（异步轮询/回调用） */
  providerTaskId?: string;
  status: TaskStatus;
  result?: T;
  error?: string;
}

export interface ProviderError extends Error {
  code: string; // UNAUTHORIZED | RATE_LIMIT | INVALID_REQUEST | TIMEOUT | UPSTREAM | MOCK_UNAVAILABLE
  retryable: boolean;
  provider: string;
}

export function providerError(
  provider: string,
  message: string,
  code: ProviderError["code"] = "UPSTREAM",
  retryable = true
): ProviderError {
  const err = new Error(message) as ProviderError;
  err.provider = provider;
  err.code = code;
  err.retryable = retryable;
  return err;
}

// ========== LLM ==========

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  /** 要求 JSON 结构化输出 */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  id: string;
  /** 流式生成文本 */
  chat(messages: LLMMessage[], opts?: LLMOptions): Promise<string>;
  /** 流式生成（剧本预览用），返回 AsyncIterable */
  streamChat?(messages: LLMMessage[], opts?: LLMOptions): AsyncIterable<string>;
  /** 供应商显示名 */
  displayName: string;
}

// ========== 图像 ==========

export type ImageMode = "t2i" | "i2i" | "edit";

export interface ImageGenerateOptions {
  prompt: string;
  size?: "1K" | "2K" | "1024x1024" | "1280x720" | "720x1280";
  /** ★ 多参考图（角色/场景/风格），绝对路径或 URL */
  refImages?: string[];
  /** 组图数量（1-15，>1 时启用组图模式） */
  count?: number;
  /** 负向提示词 */
  negativePrompt?: string;
  /** 出图比例 */
  aspectRatio?: "1:1" | "16:9" | "9:16" | "3:4" | "4:3";
}

export interface ImageProvider {
  id: string;
  generate(opts: ImageGenerateOptions): Promise<TaskHandle<{ imagePaths: string[] }>>;
  displayName: string;
}

// ========== 视频 ==========

export interface VideoGenerateOptions {
  /** 分镜图（绝对路径） */
  imagePath: string;
  /** 微动态描述 */
  prompt: string;
  /** ★ 主体参考图（可灵 3.0 Omni 角色一致性） */
  refImages?: string[];
  /** 时长（秒） */
  duration: 5 | 10;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  /** 首帧尾帧控制（可选） */
  tailImagePath?: string;
  /** 是否需要平台回调通知（webhook） */
  needCallback?: boolean;
}

export interface VideoProvider {
  id: string;
  /** 提交生成任务（异步） */
  submit(opts: VideoGenerateOptions): Promise<TaskHandle>;
  /** 查询任务状态（轮询） */
  getTask(providerTaskId: string): Promise<TaskHandle<{ videoPath: string }>>;
  displayName: string;
}

// ========== TTS ==========

export interface TTSVoice {
  id: string;
  name: string;
  previewUrl?: string;
  gender?: "male" | "female" | "neutral";
}

export interface TTSSynthesizeOptions {
  text: string;
  voiceId: string;
  /** 情绪：happy/sad/angry/fearful/calm/neutral */
  emotion?: string;
  rate?: number; // 0.5 - 2.0
  /** 输出采样率 */
  sampleRate?: 16000 | 24000 | 48000;
}

export interface TTSSubtitle {
  start: number; // ms
  end: number; // ms
  text: string;
}

export interface TTSProvider {
  id: string;
  synthesize(opts: TTSSynthesizeOptions): Promise<TaskHandle<{ audioPath: string; subtitles?: TTSSubtitle[] }>>;
  listVoices(): Promise<TTSVoice[]>;
  /** 声音复刻（可选能力） */
  cloneVoice?(sampleAudioPath: string, name: string): Promise<{ voiceId: string }>;
  displayName: string;
}

// ========== 音乐/音效 ==========

export interface MusicGenerateOptions {
  mood: string; // 情绪标签: tension/warmth/mystery/sadness/excitement...
  duration: number; // 秒
  scene?: string; // 场景描述
}

export interface MusicProvider {
  id: string;
  generate(opts: MusicGenerateOptions): Promise<TaskHandle<{ audioPath: string }>>;
  displayName: string;
}

export interface SFXEntry {
  path: string;
  label: string;
  tags: string[];
}

export interface SFXProvider {
  id: string;
  /** 按标签搜索素材库 */
  search(tags: string[]): Promise<SFXEntry[]>;
  displayName: string;
}

// ========== 注册表 ==========

export interface ProviderRegistry {
  llm: LLMProvider;
  image: ImageProvider;
  video: VideoProvider;
  tts: TTSProvider;
  music: MusicProvider;
  sfx: SFXProvider;
}
