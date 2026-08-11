/**
 * TTS 供应商实现：微软 Edge TTS(默认,免费无Key) / 阿里百炼 CosyVoice / Mock
 *
 * 所有 provider 仅读取 tts.* 分类配置（tts.engine / tts.apiKey / tts.model / tts.voice）。
 * - engine 为空（未配置）→ Mock。
 * - 配置 TTS_ENGINE=edge-tts + TTS_VOICE=zh-CN-YunxiNeural 后即可直接使用（无需 Key）。
 * - 配置 TTS_ENGINE=cosyvoice + TTS_API_KEY + TTS_MODEL=cosyvoice-v2 后使用阿里百炼。
 *
 * 接口已预留扩展位：新增引擎只需在本文件实现并接入 createTTSProvider 工厂。
 */
import { randomUUID } from "node:crypto";
import type {
  TaskHandle,
  TTSProvider,
  TTSSynthesizeOptions,
  TTSVoice,
} from "@/lib/providers/types";
import { providerError } from "@/lib/providers/types";
import { getTTSConfig, maskKey, startTimer } from "@/lib/providers/settings";
import { saveFile } from "@/lib/storage";

export const EDGE_TTS_PROVIDER_ID = "edge-tts";
export const COSYVOICE_PROVIDER_ID = "cosyvoice";

// ========== 微软 Edge TTS（免费，无需 API Key） ==========

/** Edge TTS 常用中文音色 */
export const EDGE_TTS_VOICES: TTSVoice[] = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（女·温暖）", gender: "female" },
  { id: "zh-CN-YunxiNeural", name: "云希（男·沉稳）", gender: "male" },
  { id: "zh-CN-YunyangNeural", name: "云扬（男·新闻）", gender: "male" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊（女·活泼）", gender: "female" },
  { id: "zh-CN-YunjianNeural", name: "云健（男·运动）", gender: "male" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵（女·知性）", gender: "female" },
  { id: "zh-CN-XiaomengNeural", name: "晓梦（女·亲切）", gender: "female" },
  { id: "zh-CN-XiaomoNeural", name: "晓墨（女·成熟）", gender: "female" },
  { id: "zh-CN-XiaoruiNeural", name: "晓睿（女·长者）", gender: "female" },
  { id: "zh-CN-XiaoshuangNeural", name: "晓双（女·童声）", gender: "female" },
  { id: "zh-CN-YunfengNeural", name: "云枫（男·磁性）", gender: "male" },
  { id: "zh-CN-YunhaoNeural", name: "云皓（男·宣传）", gender: "male" },
  { id: "zh-CN-YunzeNeural", name: "云泽（男· mature）", gender: "male" },
  { id: "zh-CN-YunxiaNeural", name: "云夏（男·童声）", gender: "male" },
];

const EDGE_TTS_WS =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/** Node 全局 WebSocket（Node 22+ 稳定；运行时不存在则报错） */
function getWebSocket(): typeof WebSocket {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) {
    throw providerError(
      "edge-tts",
      "当前 Node 运行时不支持全局 WebSocket（需 Node 22+），Edge TTS 不可用",
      "MOCK_UNAVAILABLE",
      false
    );
  }
  return WS;
}

/** 速率 (0.5-2.0) → Edge TTS 百分比字符串 (+0% / -10% / +50%) */
function rateToPercent(rate?: number): string {
  if (!rate || rate === 1) return "+0%";
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function buildSsml(voice: string, text: string, rate?: number): string {
  // 转义 XML 特殊字符
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${voice}'><prosody rate='${rateToPercent(rate)}' pitch='+0Hz' volume='+0%'>${esc}</prosody></voice></speak>`;
}

export function createEdgeTTSProvider(): TTSProvider {
  return {
    id: EDGE_TTS_PROVIDER_ID,
    displayName: "微软 Edge TTS（免费）",
    async listVoices(): Promise<TTSVoice[]> {
      return EDGE_TTS_VOICES;
    },
    async synthesize(opts: TTSSynthesizeOptions): Promise<TaskHandle<{ audioPath: string }>> {
      const elapsed = startTimer();
      if (!opts.text?.trim()) {
        console.error(`[tts:edge-tts] 参数错误：合成文本为空 耗时=${elapsed()}ms`);
        throw providerError("edge-tts", "合成文本为空", "INVALID_REQUEST", false);
      }
      const cfg = await getTTSConfig();
      const voice = opts.voiceId || cfg.voice || "zh-CN-YunxiNeural";
      console.log(`[tts:edge-tts] 合成 voice=${voice} rate=${opts.rate ?? 1} textLen=${opts.text.length} key=${maskKey(cfg.apiKey)}`);
      const WS = getWebSocket();
      const connId = randomUUID().replaceAll("-", "");
      const reqId = randomUUID().replaceAll("-", "");
      const url = `${EDGE_TTS_WS}&ConnectionId=${connId}`;

      return await new Promise<TaskHandle<{ audioPath: string }>>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let turnEnded = false;
        const ws = new WS(url);

        const timeout = setTimeout(() => {
          try { ws.close(); } catch { /* noop */ }
          if (!turnEnded) {
            console.error(`[tts:edge-tts] 超时 voice=${voice} textLen=${opts.text.length} 耗时=${elapsed()}ms`);
            reject(providerError("edge-tts", "Edge TTS 合成超时", "TIMEOUT", true));
          }
        }, 30_000);

        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          console.log(`[tts:edge-tts] WebSocket 已连接 connId=${connId} 耗时=${elapsed()}ms`);
          // 1. 配置消息
          const configMsg =
            "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                  },
                },
              },
            });
          ws.send(configMsg);
          // 2. SSML 消息
          const ssmlMsg =
            `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n` +
            buildSsml(voice, opts.text.slice(0, 3000), opts.rate);
          ws.send(ssmlMsg);
        };

        ws.onmessage = (event: MessageEvent) => {
          const data = event.data;
          if (typeof data === "string") {
            // 文本消息：检测 turn.end
            if (data.includes("Path:turn.end")) {
              turnEnded = true;
              clearTimeout(timeout);
              try { ws.close(); } catch { /* noop */ }
              const audio = Buffer.concat(chunks);
              if (audio.length === 0) {
                console.error(`[tts:edge-tts] 返回空音频 voice=${voice} textLen=${opts.text.length} 耗时=${elapsed()}ms`);
                reject(providerError("edge-tts", "Edge TTS 返回空音频", "UPSTREAM", true));
                return;
              }
              const audioPath = saveFile("audio", audio, ".mp3");
              console.log(`[tts:edge-tts] 成功 voice=${voice} audio=${audio.length}字节 path=${audioPath} 耗时=${elapsed()}ms`);
              resolve({ taskId: `tts-${Date.now()}`, status: "done", result: { audioPath } });
            }
          } else if (data instanceof ArrayBuffer) {
            // 二进制帧：[2字节大端 header 长度][header 文本][音频数据]
            const buf = Buffer.from(data);
            if (buf.length < 2) return;
            const headerLen = buf.readUInt16BE(0);
            const header = buf.subarray(2, 2 + headerLen).toString("utf8");
            if (header.includes("Path:audio")) {
              const audioData = buf.subarray(2 + headerLen);
              if (audioData.length > 0) chunks.push(audioData);
            }
          }
        };

        ws.onerror = (ev: Event) => {
          clearTimeout(timeout);
          const reason = (ev as ErrorEvent)?.message ?? "未知错误";
          console.error(`[tts:edge-tts] WebSocket 错误 voice=${voice} 耗时=${elapsed()}ms reason=${reason}`);
          reject(providerError("edge-tts", `Edge TTS 连接失败: ${reason}`, "UPSTREAM", true));
        };

        ws.onclose = () => {
          clearTimeout(timeout);
          if (!turnEnded) {
            console.error(`[tts:edge-tts] 连接关闭但未完成合成 voice=${voice} 耗时=${elapsed()}ms`);
            reject(providerError("edge-tts", "Edge TTS 连接关闭但未完成合成", "UPSTREAM", true));
          }
        };
      });
    },
  };
}

// ========== 阿里百炼 CosyVoice ==========

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
  return {
    id: COSYVOICE_PROVIDER_ID,
    displayName: "阿里百炼 CosyVoice",

    async listVoices(): Promise<TTSVoice[]> {
      return COSYVOICE_VOICES;
    },

    async synthesize(opts: TTSSynthesizeOptions): Promise<TaskHandle<{ audioPath: string }>> {
      const elapsed = startTimer();
      if (!opts.text?.trim()) {
        console.error(`[tts:cosyvoice] 参数错误：合成文本为空 耗时=${elapsed()}ms`);
        throw providerError("cosyvoice", "合成文本为空", "INVALID_REQUEST", false);
      }
      const cfg = await getTTSConfig();
      if (!cfg.apiKey) {
        console.error(`[tts:cosyvoice] 鉴权失败：TTS_API_KEY 未配置 key=${maskKey(cfg.apiKey)} 耗时=${elapsed()}ms`);
        throw providerError("cosyvoice", "未配置 TTS_API_KEY（阿里百炼 DashScope）", "UNAUTHORIZED", false);
      }
      const model = cfg.model || "cosyvoice-v2";
      const format: string = "mp3";
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      };
      const voice = opts.voiceId || "";
      console.log(`[tts:cosyvoice] 合成 model=${model} voice=${voice} key=${maskKey(cfg.apiKey)} format=${format} textLen=${opts.text.length}`);

      const body = {
        model,
        input: {
          text: opts.text.slice(0, 2000),
          voice,
          format,
          sample_rate: opts.sampleRate ?? 24000,
        },
      };

      const url = `${DASHSCOPE_BASE}/api/v1/services/audio/tts/SpeechSynthesizer`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (e) {
        console.error(`[tts:cosyvoice] 网络错误 url=${url} model=${model} voice=${voice} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw providerError("cosyvoice", `CosyVoice 网络错误: ${e instanceof Error ? e.message : String(e)}`, "UPSTREAM", true);
      }
      console.log(`[tts:cosyvoice] 响应 status=${res.status} 耗时=${elapsed()}ms`);

      // 错误时返回 JSON {code, message}，成功时返回音频二进制
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || contentType.includes("application/json")) {
        const json = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
        console.error(`[tts:cosyvoice] 失败 status=${res.status} url=${url} model=${model} voice=${voice} 耗时=${elapsed()}ms code=${json.code ?? ""} message=${json.message ?? res.statusText}`);
        throw providerError(
          "cosyvoice",
          `CosyVoice 合成失败: ${json.message ?? res.statusText}`,
          res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM",
          res.status >= 500
        );
      }

      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) {
        console.error(`[tts:cosyvoice] 返回空音频 model=${model} voice=${voice} ct=${contentType} 耗时=${elapsed()}ms`);
        throw providerError("cosyvoice", "CosyVoice 返回空音频", "UPSTREAM", true);
      }
      const ext = format === "wav" ? ".wav" : format === "pcm" ? ".pcm" : ".mp3";
      const audioPath = await saveFile("audio", audio, ext);
      console.log(`[tts:cosyvoice] 成功 model=${model} voice=${voice} audio=${audio.length}字节 path=${audioPath} 总耗时=${elapsed()}ms`);
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
  const cfg = await getTTSConfig();
  const engine = id ?? cfg.engine;
  if (engine === EDGE_TTS_PROVIDER_ID) return createEdgeTTSProvider();
  if (engine === COSYVOICE_PROVIDER_ID) return createCosyVoiceProvider();
  return createMockTTSProvider();
}
