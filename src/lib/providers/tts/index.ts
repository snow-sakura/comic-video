/**
 * TTS 供应商实现：阿里百炼 CosyVoice / Mock
 * 端点: POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 * 非流式，返回二进制音频（mp3/wav/pcm）
 */
import type {
  TaskHandle,
  TTSProvider,
  TTSSynthesizeOptions,
  TTSVoice,
} from "@/lib/providers/types";
import { providerError } from "@/lib/providers/types";
import { getApiKey, getSetting } from "@/lib/providers/settings";
import { saveFile } from "@/lib/storage";

export const COSYVOICE_PROVIDER_ID = "cosyvoice";

const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com";

/** CosyVoice 系统音色（v2 后缀为 model_id，REST 接口直接使用） */
export const COSYVOICE_VOICES: TTSVoice[] = [
  { id: "longxiaochun_v2", name: "龙小淳（知性女）", gender: "female" },
  { id: "longxiaoxia_v2", name: "龙小夏（沉稳女）", gender: "female" },
  { id: "longyue_v2", name: "龙悦（温柔女）", gender: "female" },
  { id: "longmiao_v2", name: "龙淼（有声书女）", gender: "female" },
  { id: "longhua_v2", name: "龙华（活力甜美女）", gender: "female" },
  { id: "longhuhu", name: "龙虎虎（童声女）", gender: "female" },
  { id: "longxiu_v2", name: "龙修（博学男）", gender: "male" },
  { id: "longcheng_v2", name: "龙诚（睿智青年）", gender: "male" },
  { id: "longze_v2", name: "龙泽（阳光男）", gender: "male" },
  { id: "longtian_v2", name: "龙天（磁性男）", gender: "male" },
  { id: "longhan_v2", name: "龙翰（深情男）", gender: "male" },
  { id: "longjielidou_v2", name: "龙杰力豆（童声男）", gender: "male" },
];

export function createCosyVoiceProvider(): TTSProvider {
  async function authHeader(): Promise<Record<string, string>> {
    const key = (await getApiKey("dashscope")) ?? "";
    if (!key) {
      throw providerError("cosyvoice", "未配置 DashScope API Key", "UNAUTHORIZED", false);
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
  }

  return {
    id: COSYVOICE_PROVIDER_ID,
    displayName: "阿里百炼 CosyVoice",

    async listVoices(): Promise<TTSVoice[]> {
      return COSYVOICE_VOICES;
    },

    async synthesize(opts: TTSSynthesizeOptions): Promise<TaskHandle<{ audioPath: string }>> {
      if (!opts.text?.trim()) {
        throw providerError("cosyvoice", "合成文本为空", "INVALID_REQUEST", false);
      }
      const headers = await authHeader();
      const model = (await getSetting<string>("tts.cosyvoice.model")) ?? "cosyvoice-v2";
      const format = (await getSetting<string>("tts.cosyvoice.format")) ?? "mp3";

      const body = {
        model,
        input: {
          text: opts.text.slice(0, 2000),
          voice: opts.voiceId,
          format,
          sample_rate: opts.sampleRate ?? 24000,
        },
      };

      const res = await fetch(`${DASHSCOPE_BASE}/api/v1/services/audio/tts/SpeechSynthesizer`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      // 错误时返回 JSON {code, message}，成功时返回音频二进制
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || contentType.includes("application/json")) {
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        throw providerError(
          "cosyvoice",
          `CosyVoice 合成失败: ${json.message ?? res.statusText}`,
          res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM",
          res.status >= 500
        );
      }

      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) {
        throw providerError("cosyvoice", "CosyVoice 返回空音频", "UPSTREAM", true);
      }
      const ext = format === "wav" ? ".wav" : format === "pcm" ? ".pcm" : ".mp3";
      const audioPath = await saveFile("audio", audio, ext);
      return { taskId: `tts-${Date.now()}`, status: "done", result: { audioPath } };
    },
  };
}

// ========== Mock ==========

export function createMockTTSProvider(): TTSProvider {
  return {
    id: "mock-tts",
    displayName: "Mock TTS（无Key演示）",
    async listVoices(): Promise<TTSVoice[]> {
      return [
        { id: "mock-female", name: "演示女声", gender: "female" },
        { id: "mock-male", name: "演示男声", gender: "male" },
      ];
    },
    async synthesize(opts: TTSSynthesizeOptions): Promise<TaskHandle<{ audioPath: string }>> {
      // 生成 440Hz 正弦波占位音频（wav，16bit mono），时长按文本长度估算
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { uniqueName } = await import("@/lib/storage");
      const execFileAsync = promisify(execFile);
      const { path, relPath } = uniqueName("audio", ".wav");
      const estSec = Math.max(1, Math.min(30, Math.ceil(opts.text.length / 4)));
      try {
        await execFileAsync("ffmpeg", [
          "-f", "lavfi",
          "-i", `sine=frequency=440:duration=${estSec}`,
          "-ar", String(opts.sampleRate ?? 24000),
          "-ac", "1",
          "-y", path,
        ]);
        return { taskId: `tts-${Date.now()}`, status: "done", result: { audioPath: relPath } };
      } catch {
        // ffmpeg 不可用：写占位文件
        const audioPath = await saveFile("audio", Buffer.from("mock-tts"), ".wav");
        return { taskId: `tts-${Date.now()}`, status: "done", result: { audioPath } };
      }
    },
  };
}

// ========== 工厂 ==========

export async function createTTSProvider(id?: string): Promise<TTSProvider> {
  const providerId = id ?? (await getSetting<string>("tts.provider")) ?? COSYVOICE_PROVIDER_ID;
  if (providerId === COSYVOICE_PROVIDER_ID) return createCosyVoiceProvider();
  return createMockTTSProvider();
}
