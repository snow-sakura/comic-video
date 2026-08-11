/**
 * LLM 供应商单元测试 — 覆盖 6 个模型调用点
 *   glm chat / glm streamChat / deepseek chat / deepseek streamChat / doubao chat / doubao streamChat
 *
 * 每个调用点覆盖：
 *   - 正常流程（成功返回文本）
 *   - 鉴权失败（无 API Key）
 *   - SDK 异常（generateText / streamText reject）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ========== 模块 mock ==========

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({ chat: vi.fn(() => ({})) })),
}));
vi.mock("@ai-sdk/deepseek", () => ({
  createDeepSeek: vi.fn(() => ({ chat: vi.fn(() => ({})) })),
}));
vi.mock("@/lib/providers/settings", () => ({
  getTextConfig: vi.fn(),
  maskKey: (k?: string) => (k ? `${k.slice(0, 4)}****` : "(未配置)"),
  startTimer: () => () => 42,
}));

import { generateText, streamText } from "ai";
import { getTextConfig } from "@/lib/providers/settings";
import { createGlmProvider, createDeepSeekProvider, createDoubaoProvider } from "@/lib/providers/llm";

// ========== 辅助 ==========

const MOCK_KEY = "test-api-key-12345";
const msgs = [{ role: "user" as const, content: "你好" }];

function setConfig(overrides: Record<string, unknown> = {}): void {
  vi.mocked(getTextConfig).mockResolvedValue({
    provider: "glm",
    apiKey: MOCK_KEY,
    model: "glm-4.7-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    ...overrides,
  });
}

function mockGenerateTextSuccess(text = "模拟回复"): void {
  vi.mocked(generateText).mockResolvedValue({ text, usage: { totalTokens: 10 } } as never);
}

function mockGenerateTextReject(error: Error): void {
  vi.mocked(generateText).mockRejectedValue(error);
}

/** 构造 mock streamText：yield 分块后正常结束 */
function mockStreamTextSuccess(chunks: string[]): void {
  vi.mocked(streamText).mockReturnValue({
    textStream: (async function* () {
      for (const c of chunks) yield c;
    })(),
  } as never);
}

function mockStreamTextReject(error: Error): void {
  vi.mocked(streamText).mockReturnValue({
    textStream: (async function* () {
      throw error;
    })(),
  } as never);
}

/** 消费 AsyncIterable 首块，用于测试 streamChat 抛错场景 */
async function consumeFirstChunk(iter: AsyncIterable<string>): Promise<void> {
  for await (const __ of iter) break;
}

// ========== 测试 ==========

beforeEach(() => {
  vi.clearAllMocks();
  setConfig();
});

describe("[LLM:GLM] chat", () => {
  it("正常流程：返回生成文本", async () => {
    mockGenerateTextSuccess("这是 GLM 的回复");
    const result = await createGlmProvider().chat(msgs);
    expect(result).toBe("这是 GLM 的回复");
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined });
    await expect(createGlmProvider().chat(msgs)).rejects.toThrow("未配置 TEXT_API_KEY");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("SDK 异常：generateText reject 时透传错误", async () => {
    mockGenerateTextReject(new Error("rate limit exceeded"));
    await expect(createGlmProvider().chat(msgs)).rejects.toThrow("rate limit exceeded");
  });
});

describe("[LLM:GLM] streamChat", () => {
  it("正常流程：逐块 yield 文本", async () => {
    mockStreamTextSuccess(["你好", "世界"]);
    const provider = createGlmProvider();
    const chunks: string[] = [];
    for await (const c of provider.streamChat!(msgs)) chunks.push(c);
    expect(chunks).toEqual(["你好", "世界"]);
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined });
    await expect(consumeFirstChunk(createGlmProvider().streamChat!(msgs))).rejects.toThrow("未配置 TEXT_API_KEY");
  });

  it("SDK 异常：streamText 内部抛错时透传", async () => {
    mockStreamTextReject(new Error("connection reset"));
    await expect(consumeFirstChunk(createGlmProvider().streamChat!(msgs))).rejects.toThrow("connection reset");
  });
});

describe("[LLM:DeepSeek] chat", () => {
  it("正常流程：返回生成文本", async () => {
    mockGenerateTextSuccess("DeepSeek 回复");
    const result = await createDeepSeekProvider().chat(msgs, { temperature: 0.5 });
    expect(result).toBe("DeepSeek 回复");
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined, provider: "deepseek" });
    await expect(createDeepSeekProvider().chat(msgs)).rejects.toThrow("未配置 TEXT_API_KEY");
  });

  it("SDK 异常：错误透传", async () => {
    mockGenerateTextReject(new Error("timeout"));
    await expect(createDeepSeekProvider().chat(msgs)).rejects.toThrow("timeout");
  });
});

describe("[LLM:DeepSeek] streamChat", () => {
  it("正常流程：逐块 yield", async () => {
    mockStreamTextSuccess(["DS", "流式"]);
    const chunks: string[] = [];
    for await (const c of createDeepSeekProvider().streamChat!(msgs)) chunks.push(c);
    expect(chunks).toEqual(["DS", "流式"]);
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined });
    await expect(consumeFirstChunk(createDeepSeekProvider().streamChat!(msgs))).rejects.toThrow("未配置 TEXT_API_KEY");
  });
});

describe("[LLM:Doubao] chat", () => {
  it("正常流程：返回生成文本", async () => {
    mockGenerateTextSuccess("豆包回复");
    const result = await createDoubaoProvider().chat(msgs, { json: true });
    expect(result).toBe("豆包回复");
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined, provider: "doubao" });
    await expect(createDoubaoProvider().chat(msgs)).rejects.toThrow("未配置 TEXT_API_KEY");
  });

  it("SDK 异常：错误透传", async () => {
    mockGenerateTextReject(new Error("server error"));
    await expect(createDoubaoProvider().chat(msgs)).rejects.toThrow("server error");
  });
});

describe("[LLM:Doubao] streamChat", () => {
  it("正常流程：逐块 yield", async () => {
    mockStreamTextSuccess(["豆包", "流式"]);
    const chunks: string[] = [];
    for await (const c of createDoubaoProvider().streamChat!(msgs)) chunks.push(c);
    expect(chunks).toEqual(["豆包", "流式"]);
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined });
    await expect(consumeFirstChunk(createDoubaoProvider().streamChat!(msgs))).rejects.toThrow("未配置 TEXT_API_KEY");
  });
});
