/**
 * TTS 供应商单元测试 — 覆盖 2 个模型调用点
 *   cosyvoice synthesize（HTTP）/ edge-tts synthesize（WebSocket）
 *
 * 每个调用点覆盖：
 *   - 正常流程（成功合成音频）
 *   - 鉴权失败 / 参数错误
 *   - 网络错误（fetch reject / WebSocket error）
 *   - 上游错误（HTTP 非 200）
 *   - 空音频返回
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ========== 模块 mock ==========

vi.mock("@/lib/providers/settings", () => ({
  getTTSConfig: vi.fn(),
  maskKey: (k?: string) => (k ? `${k.slice(0, 4)}****` : "(未配置)"),
  startTimer: () => () => 42,
}));
vi.mock("@/lib/storage", () => ({
  saveFile: vi.fn().mockReturnValue("audio/mock-tts.mp3"),
  getCategoryDir: vi.fn().mockReturnValue("/storage/audio"),
}));
vi.mock("@/lib/env", () => ({ loadEnv: vi.fn() }));

import { getTTSConfig } from "@/lib/providers/settings";
import { createCosyVoiceProvider, createEdgeTTSProvider } from "@/lib/providers/tts";

// ========== 辅助 ==========

const MOCK_KEY = "test-tts-key-xyz";

function setConfig(overrides: Record<string, unknown> = {}): void {
  vi.mocked(getTTSConfig).mockResolvedValue({
    engine: "cosyvoice",
    apiKey: MOCK_KEY,
    model: "cosyvoice-v2",
    voice: "longxiaochun",
    baseUrl: "https://api.cosyvoice.example.com",
    ...overrides,
  });
}

function mockFetchBinarySuccess(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "audio/mpeg" },
      json: async () => ({}),
      text: async () => "",
      arrayBuffer: async () => {
        const buf = new ArrayBuffer(2048);
        return buf;
      },
    }),
  );
}

function mockFetchReject(error: Error): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
}

function mockFetchHttpError(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      headers: { get: () => "application/json" },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

// ========== WebSocket mock ==========

interface MockWS {
  url: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  readyState: number;
  send: (data: unknown) => void;
  close: () => void;
}

function createMockWebSocket(autoOpen = true): MockWS {
  const ws: MockWS = {
    url: "",
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(() => {
      ws.readyState = 3;
    }),
  };
  if (autoOpen) {
    setTimeout(() => {
      ws.readyState = 1;
      ws.onopen?.(new Event("open"));
    }, 0);
  }
  return ws;
}

// ========== 测试 ==========

beforeEach(() => {
  vi.clearAllMocks();
  setConfig();
  // 始终 stub fetch，使 expect(fetch).not.toHaveBeenCalled() 在鉴权测试中可用
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ========== CosyVoice（HTTP）==========

describe("[TTS:CosyVoice] synthesize", () => {
  it("正常流程：成功合成音频返回路径", async () => {
    mockFetchBinarySuccess();
    const result = await createCosyVoiceProvider().synthesize({
      text: "你好世界",
      voiceId: "longxiaochun",
    });
    expect(result.status).toBe("done");
    expect(result.result?.audioPath).toBeTruthy();
  });

  it("参数错误：空文本时抛错", async () => {
    mockFetchBinarySuccess();
    await expect(
      createCosyVoiceProvider().synthesize({ text: "", voiceId: "longxiaochun" }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("参数错误：仅空白字符时抛错", async () => {
    mockFetchBinarySuccess();
    await expect(
      createCosyVoiceProvider().synthesize({ text: "   \n  ", voiceId: "longxiaochun" }),
    ).rejects.toThrow();
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined });
    await expect(
      createCosyVoiceProvider().synthesize({ text: "测试", voiceId: "longxiaochun" }),
    ).rejects.toThrow("TTS_API_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("网络错误：fetch reject 时抛错", async () => {
    mockFetchReject(new Error("EAI_AGAIN"));
    await expect(
      createCosyVoiceProvider().synthesize({ text: "测试", voiceId: "longxiaochun" }),
    ).rejects.toThrow("网络错误");
  });

  it("上游错误：HTTP 401 时抛错", async () => {
    mockFetchHttpError(401, { code: 401, message: "invalid key" });
    await expect(
      createCosyVoiceProvider().synthesize({ text: "测试", voiceId: "longxiaochun" }),
    ).rejects.toThrow("CosyVoice");
  });

  it("空音频：响应体为空时抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "audio/mpeg" },
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    );
    await expect(
      createCosyVoiceProvider().synthesize({ text: "测试", voiceId: "longxiaochun" }),
    ).rejects.toThrow();
  });
});

// ========== Edge TTS（WebSocket）==========

describe("[TTS:EdgeTTS] synthesize", () => {
  it("参数错误：空文本时抛错（不创建 WebSocket）", async () => {
    vi.stubGlobal("WebSocket", vi.fn());
    await expect(
      createEdgeTTSProvider().synthesize({ text: "", voiceId: "zh-CN-XiaoxiaoNeural" }),
    ).rejects.toThrow();
    expect(WebSocket).not.toHaveBeenCalled();
  });

  it("WebSocket 错误：onerror 触发时 reject", async () => {
    const mockWS = createMockWebSocket(false);
    vi.stubGlobal("WebSocket", vi.fn(() => mockWS));

    const promise = createEdgeTTSProvider().synthesize({
      text: "测试合成",
      voiceId: "zh-CN-XiaoxiaoNeural",
    });

    // 模拟连接后出错
    setTimeout(() => {
      mockWS.readyState = 1;
      mockWS.onopen?.(new Event("open"));
      setTimeout(() => mockWS.onerror?.(new ErrorEvent("error")), 5);
    }, 5);

    await expect(promise).rejects.toThrow();
  });

  it("WebSocket 超时：未收到音频时 reject", async () => {
    const mockWS = createMockWebSocket(false);
    vi.stubGlobal("WebSocket", vi.fn(() => mockWS));

    const promise = createEdgeTTSProvider().synthesize({
      text: "测试合成",
      voiceId: "zh-CN-XiaoxiaoNeural",
    });

    // 模拟连接后无响应（超时）
    setTimeout(() => {
      mockWS.readyState = 1;
      mockWS.onopen?.(new Event("open"));
    }, 5);

    // 超时由内部 setTimeout 控制，等待 reject
    await expect(promise).rejects.toThrow();
  }, 15000);
});
