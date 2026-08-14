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
import { join } from "node:path";
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
/** 原生 REST 合成端点（返回 JSON { output: { audio: { url } } }，音频为 OSS 链接） */
const DASHSCOPE_TTS_PATH = "/api/v1/services/audio/tts/SpeechSynthesizer";

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
      // voiceId 必须为合法音色 ID（如 longxiaochun_v2）。角色提炼的 voiceName 是
      // LLM 生成的音色描述文本（如"清爽少年音…"），不是合法 ID，传入会被
      // DashScope 以 418 InvalidParameter 拒绝 → 校验后回退默认音色。
      let voice = opts.voiceId || cfg.voice || "longxiaochun_v2";
      if (!COSYVOICE_VOICES.some((v) => v.id === voice)) {
        console.warn(`[tts:cosyvoice] 非法音色 ID "${voice}"，回退默认音色 longxiaochun_v2`);
        voice = "longxiaochun_v2";
      }
      const baseUrl = cfg.baseUrl || DASHSCOPE_BASE;
      const format: string = opts.format ?? "mp3";
      // 默认取配置的采样率，仅 wav/pcm 时生效（mp3 固定 24000 由服务端决定）
      const sampleRate = opts.sampleRate ?? 24000;
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      };
      console.log(`[tts:cosyvoice] 合成 model=${model} voice=${voice} baseUrl=${baseUrl} key=${maskKey(cfg.apiKey)} format=${format} textLen=${opts.text.length}`);

      const body = {
        model,
        input: {
          text: opts.text.slice(0, 2000),
          voice,
          format,
          sample_rate: sampleRate,
        },
      };

      // 端点选择：
      // - baseUrl 含 dashscope.aliyuncs.com → 原生 REST（JSON + output.audio.url）
      // - 其他（自建网关/兼容端点）→ OpenAI 风格 /audio/speech（二进制）
      const isDashScope = baseUrl.includes("dashscope.aliyuncs.com");
      const url = isDashScope
        ? `${new URL(baseUrl).origin}${DASHSCOPE_TTS_PATH}`
        : `${baseUrl.replace(/\/$/, "")}/audio/speech`;

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
      console.log(`[tts:cosyvoice] 响应 status=${res.status} ct=${res.headers.get("content-type") ?? ""} 耗时=${elapsed()}ms`);

      // 错误响应：JSON {code, message}
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
        console.error(`[tts:cosyvoice] 失败 status=${res.status} url=${url} model=${model} voice=${voice} 耗时=${elapsed()}ms code=${json.code ?? ""} message=${json.message ?? res.statusText}`);
        throw providerError(
          "cosyvoice",
          `CosyVoice 合成失败: ${json.message ?? res.statusText}`,
          res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM",
          res.status >= 500
        );
      }

      let audio: Buffer;
      const contentType = res.headers.get("content-type") ?? "";

      // DashScope 原生 REST：成功时返回 JSON {output:{audio:{url}}}，需二次下载
      if (isDashScope || contentType.includes("application/json")) {
        const json = (await res.json().catch(() => ({}))) as {
          output?: { audio?: { url?: string }; task_id?: string };
          message?: string;
          code?: string;
        };
        if (json.message || json.code) {
          console.error(`[tts:cosyvoice] 合成失败 code=${json.code ?? ""} message=${json.message ?? ""} 耗时=${elapsed()}ms`);
          throw providerError("cosyvoice", `CosyVoice 合成失败: ${json.message ?? "未知错误"}`, "UPSTREAM", true);
        }
        const audioUrl = json.output?.audio?.url;
        if (!audioUrl) {
          console.error(`[tts:cosyvoice] 成功但无音频 url resp=${JSON.stringify(json).slice(0, 300)} 耗时=${elapsed()}ms`);
          throw providerError("cosyvoice", "CosyVoice 返回无音频地址", "UPSTREAM", true);
        }
        console.log(`[tts:cosyvoice] 原生接口返回音频地址 audioUrl=${audioUrl.slice(0, 80)}... 耗时=${elapsed()}ms`);
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
          console.error(`[tts:cosyvoice] 下载音频失败 status=${audioRes.status} 耗时=${elapsed()}ms`);
          throw providerError("cosyvoice", `下载音频失败（${audioRes.status}）`, "UPSTREAM", true);
        }
        audio = Buffer.from(await audioRes.arrayBuffer());
      } else {
        // OpenAI 兼容风格：直接返回音频二进制
        audio = Buffer.from(await res.arrayBuffer());
      }

      if (audio.length === 0) {
        console.error(`[tts:cosyvoice] 返回空音频 model=${model} voice=${voice} ct=${contentType} 耗时=${elapsed()}ms`);
        throw providerError("cosyvoice", "CosyVoice 返回空音频", "UPSTREAM", true);
      }
      const ext = format === "wav" ? ".wav" : format === "pcm" ? ".pcm" : format === "ogg" ? ".ogg" : ".mp3";
      const audioPath = await saveFile("audio", audio, ext);
      console.log(`[tts:cosyvoice] 成功 model=${model} voice=${voice} audio=${audio.length}字节 path=${audioPath} 总耗时=${elapsed()}ms`);
      return { taskId: `tts-${Date.now()}`, status: "done", result: { audioPath } };
    },
  };
}

// ========== 网易有道 Confucius4-TTS（Gradio 语音克隆，无需 API Key） ==========
// 服务地址：https://confucius4-tts.youdao.com/gradio/
// 协议：gradio 4.44 queue/join + queue/data（SSE 长轮询），需参考音频（语音克隆）
// 参考音频：storage/reference-voices/seed_*.wav（由 scripts/gen-reference-voices.ts 生成）
// 说明：模型为语音克隆，音色由参考音频决定；角色 voiceName 描述文本经 matchVoiceId 智能匹配音色。

export const CONFUCIUS4_PROVIDER_ID = "confucius4";
export const CONFUCIUS4_BASE = "https://confucius4-tts.youdao.com/gradio";

/** Confucius4 内置音色库（seed = 参考音频文件名，决定克隆音色特征） */
export const CONFUCIUS4_VOICES: (TTSVoice & { seed: string })[] = [
  { id: "confucius-feminine", name: "柔美女声（清亮温柔）", gender: "female", seed: "seed_Flo.wav" },
  { id: "confucius-mellow", name: "温和男声（青年沉稳）", gender: "male", seed: "seed_Eddy.wav" },
  { id: "confucius-mature-f", name: "慈祥女声（年长）", gender: "female", seed: "seed_Grandma.wav" },
  { id: "confucius-deep", name: "低沉男声（年长威严）", gender: "male", seed: "seed_Grandpa.wav" },
  { id: "confucius-clear", name: "清朗男声（少年意气）", gender: "male", seed: "seed_Reed.wav" },
  { id: "confucius-raspy", name: "浑厚男声（磁性沙哑）", gender: "male", seed: "seed_Rocko.wav" },
];

/** 音色关键词 → 音色 ID 规则表（描述文本智能匹配，按权重从高到低） */
const VOICE_MATCH_RULES: { keywords: string[]; voiceId: string }[] = [
  { keywords: ["少女", "清脆", "俏皮", "甜", "清亮女"], voiceId: "confucius-feminine" },
  { keywords: ["少年", "青年男", "清朗", "阳光"], voiceId: "confucius-clear" },
  { keywords: ["慈祥", "年长女", "老妇", "奶奶"], voiceId: "confucius-mature-f" },
  { keywords: ["低沉", "苍老", "老者", "沧桑", "威严", "压迫"], voiceId: "confucius-deep" },
  { keywords: ["沙哑", "浑厚", "磁性", "豪爽", "厚重", "粗犷"], voiceId: "confucius-raspy" },
  { keywords: ["温和", "沉稳", "知性", "温柔", "成熟"], voiceId: "confucius-mellow" },
];

/** 音色描述文本 → Confucius4 音色 ID（无法匹配时按性别兜底，最后默认柔美女声） */
export function matchVoiceId(desc?: string, gender?: string): string {
  const text = desc?.trim() ?? "";
  for (const rule of VOICE_MATCH_RULES) {
    if (text && rule.keywords.some((k) => text.includes(k))) return rule.voiceId;
  }
  if (gender === "female") return "confucius-feminine";
  if (gender === "male") return "confucius-mellow";
  return "confucius-feminine";
}

/** 上传参考音频到 gradio 服务器，返回远程文件 path */
async function uploadToGradio(filePath: string, baseUrl: string): Promise<string> {
  const fd = new FormData();
  fd.append("files", new Blob([await import("node:fs/promises").then((m) => m.readFile(filePath))], { type: "audio/wav" }), filePath.split("/").pop() ?? "ref.wav");
  const res = await fetch(`${baseUrl}/upload`, { method: "POST", body: fd });
  if (!res.ok) throw providerError("confucius4", `参考音频上传失败 status=${res.status}`, "UPSTREAM", true);
  const arr = (await res.json()) as string[];
  if (!Array.isArray(arr) || arr.length === 0) throw providerError("confucius4", "参考音频上传返回为空", "UPSTREAM", true);
  return arr[0];
}

/** 调用 gradio queue/join 提交任务并轮询 SSE 直到完成，返回输出音频 URL */
async function gradioSynthesize(
  baseUrl: string,
  text: string,
  refRemotePath: string
): Promise<string> {
  const sessionHash = randomUUID().replace(/-/g, "").slice(0, 20);
  const fileData = {
    path: refRemotePath,
    orig_name: refRemotePath.split("/").pop() ?? "ref.wav",
    meta: { _type: "gradio.FileData" },
  };
  const joinRes = await fetch(`${baseUrl}/queue/join?`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [text, "zh", fileData, null],
      event_data: null,
      fn_index: 1,
      trigger_id: 9,
      session_hash: sessionHash,
    }),
  });
  if (!joinRes.ok) {
    throw providerError("confucius4", `任务提交失败 status=${joinRes.status}`, "UPSTREAM", true);
  }
  // SSE 长轮询 queue/data
  const deadline = Date.now() + 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const sseRes = await fetch(`${baseUrl}/queue/data?session_hash=${sessionHash}`, { signal: controller.signal });
    if (!sseRes.ok || !sseRes.body) {
      throw providerError("confucius4", `结果流获取失败 status=${sseRes.status}`, "UPSTREAM", true);
    }
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 按 SSE 事件块解析
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let msg: { msg?: string; output?: { data?: { url?: string }[] }; success?: boolean };
        try {
          msg = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (msg.msg === "process_completed") {
          const url = msg.output?.data?.[0]?.url;
          if (!url) throw providerError("confucius4", "合成完成但无输出音频", "UPSTREAM", true);
          if (msg.success === false) throw providerError("confucius4", "合成失败（引擎错误）", "UPSTREAM", true);
          return url;
        }
        if (msg.msg === "process_starts" && !line.includes("success")) {
          // 某些版本 process_starts 无 success 字段，继续等待
        }
      }
    }
    throw providerError("confucius4", "合成超时（120s）", "UPSTREAM", true);
  } finally {
    clearTimeout(timer);
  }
}

/** 下载 gradio 输出音频（url 可能是相对路径 /gradio/file=...） */
async function downloadGradioAudio(baseUrl: string, url: string): Promise<Buffer> {
  const absUrl = url.startsWith("http") ? url : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  const res = await fetch(absUrl);
  if (!res.ok) throw providerError("confucius4", `下载合成音频失败 status=${res.status}`, "UPSTREAM", true);
  return Buffer.from(await res.arrayBuffer());
}

export function createConfucius4Provider(): TTSProvider {
  return {
    id: CONFUCIUS4_PROVIDER_ID,
    displayName: "网易有道 Confucius4-TTS（语音克隆）",

    async listVoices(): Promise<TTSVoice[]> {
      return CONFUCIUS4_VOICES;
    },

    async synthesize(opts: TTSSynthesizeOptions): Promise<TaskHandle<{ audioPath: string }>> {
      const elapsed = startTimer();
      if (!opts.text?.trim()) {
        throw providerError("confucius4", "合成文本为空", "INVALID_REQUEST", false);
      }
      const cfg = await getTTSConfig();
      const baseUrl = (cfg.baseUrl || CONFUCIUS4_BASE).replace(/\/$/, "");
      // voiceId 优先：合法 ID 直接用；否则视为 LLM 生成的音色描述，智能匹配
      const matched =
        CONFUCIUS4_VOICES.find((v) => v.id === opts.voiceId) ??
        CONFUCIUS4_VOICES.find((v) => v.id === matchVoiceId(opts.voiceId));
      const voice = matched ?? CONFUCIUS4_VOICES[0];
      const seedPath = join(process.cwd(), "storage", "reference-voices", voice.seed);
      console.log(`[tts:confucius4] 合成 textLen=${opts.text.length} voice=${voice.id} (${voice.name}) seed=${voice.seed} 耗时=${elapsed()}ms`);

      // 1. 上传参考音频
      const refRemote = await uploadToGradio(seedPath, baseUrl);
      console.log(`[tts:confucius4] 参考音频已上传 refRemote=${refRemote.slice(0, 60)}...`);

      // 2. 提交合成任务并轮询
      const outUrl = await gradioSynthesize(baseUrl, opts.text.slice(0, 500), refRemote);

      // 3. 下载音频并落盘
      const audio = await downloadGradioAudio(baseUrl, outUrl);
      if (audio.length === 0) throw providerError("confucius4", "返回空音频", "UPSTREAM", true);
      const audioPath = await saveFile("audio", audio, ".wav");
      console.log(`[tts:confucius4] 成功 voice=${voice.id} audio=${audio.length}字节 path=${audioPath} 总耗时=${elapsed()}ms`);
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
  if (engine === CONFUCIUS4_PROVIDER_ID) return createConfucius4Provider();
  return createMockTTSProvider();
}
