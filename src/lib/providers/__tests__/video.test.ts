/**
 * 视频供应商单元测试 — 覆盖 4 个模型调用点
 *   cogvideox submit / cogvideox getTask / kling submit / kling getTask
 *
 * 每个调用点覆盖：
 *   - 正常流程（成功提交 / 查询完成 / 查询处理中 / 查询失败）
 *   - 鉴权失败（无 API Key）
 *   - 网络错误（fetch reject）
 *   - 上游错误（HTTP 非 200）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ========== 模块 mock ==========

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-image-data")),
  statSync: vi.fn().mockReturnValue({ size: 1024 }),
  existsSync: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/providers/settings", () => ({
  getVideoConfig: vi.fn(),
  maskKey: (k?: string) => (k ? `${k.slice(0, 4)}****` : "(未配置)"),
  startTimer: () => () => 42,
}));
vi.mock("@/lib/storage", () => ({
  absPath: (p: string) => `/storage/${p}`,
  downloadToStorage: vi.fn().mockResolvedValue("videos/mock-video.mp4"),
  saveFile: vi.fn().mockReturnValue("videos/mock-video.mp4"),
  fileExists: vi.fn().mockReturnValue(true),
}));

import { getVideoConfig } from "@/lib/providers/settings";
import { downloadToStorage } from "@/lib/storage";
import { createCogVideoXProvider, createKlingProvider } from "@/lib/providers/video";

// ========== 辅助 ==========

const MOCK_KEY = "test-video-key-abcdef";

function setConfig(overrides: Record<string, unknown> = {}): void {
  vi.mocked(getVideoConfig).mockResolvedValue({
    provider: "cogvideox",
    apiKey: MOCK_KEY,
    secret: "test-secret",
    model: "cogvideox-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    ...overrides,
  });
}

function mockFetchSuccess(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
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
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

// ========== 测试 ==========

beforeEach(() => {
  vi.clearAllMocks();
  setConfig();
  vi.mocked(downloadToStorage).mockResolvedValue("videos/mock-video.mp4");
  // 始终 stub fetch，使 expect(fetch).not.toHaveBeenCalled() 在鉴权测试中可用
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[Video:CogVideoX] submit", () => {
  it("正常流程：成功提交返回 providerTaskId", async () => {
    mockFetchSuccess({ id: "task-12345" });
    const result = await createCogVideoXProvider().submit({
      imagePath: "shots/test.png",
      prompt: "人物呼吸",
      duration: 5,
    });
    expect(result.status).toBe("queued");
    expect(result.providerTaskId).toBe("task-12345");
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined });
    await expect(
      createCogVideoXProvider().submit({ imagePath: "shots/test.png", prompt: "测试", duration: 5 }),
    ).rejects.toThrow("未配置 VIDEO_API_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("网络错误：fetch reject 时抛错", async () => {
    mockFetchReject(new Error("ETIMEDOUT"));
    await expect(
      createCogVideoXProvider().submit({ imagePath: "shots/test.png", prompt: "测试", duration: 5 }),
    ).rejects.toThrow("网络错误");
  });

  it("上游错误：HTTP 429 时抛错", async () => {
    mockFetchHttpError(429, { error: { message: "rate limited" } });
    await expect(
      createCogVideoXProvider().submit({ imagePath: "shots/test.png", prompt: "测试", duration: 5 }),
    ).rejects.toThrow("CogVideoX");
  });
});

describe("[Video:Cog VideoX] getTask", () => {
  it("正常流程-完成：返回 done + videoPath", async () => {
    mockFetchSuccess({
      task_status: "SUCCESS",
      video_result: [{ url: "https://cdn.example.com/video.mp4" }],
    });
    const result = await createCogVideoXProvider().getTask("task-12345");
    expect(result.status).toBe("done");
    expect(result.result?.videoPath).toBe("videos/mock-video.mp4");
    expect(downloadToStorage).toHaveBeenCalled();
  });

  it("正常流程-处理中：返回 processing", async () => {
    mockFetchSuccess({ task_status: "PROCESSING" });
    const result = await createCogVideoXProvider().getTask("task-12345");
    expect(result.status).toBe("processing");
    expect(result.result).toBeUndefined();
  });

  it("正常流程-失败：返回 failed", async () => {
    mockFetchSuccess({ task_status: "FAIL", task_failure_desc: "内容违规" });
    const result = await createCogVideoXProvider().getTask("task-12345");
    expect(result.status).toBe("failed");
  });

  it("网络错误：返回 failed handle（不抛错）", async () => {
    mockFetchReject(new Error("ECONNRESET"));
    const result = await createCogVideoXProvider().getTask("task-12345");
    expect(result.status).toBe("failed");
  });
});

describe("[Video:Kling] submit", () => {
  it("正常流程：成功提交返回 providerTaskId", async () => {
    setConfig({ provider: "kling", model: "kling-3-0-omni" });
    mockFetchSuccess({ code: 0, data: { task_id: "kling-task-001" } });
    const result = await createKlingProvider().submit({
      imagePath: "shots/test.png",
      prompt: "人物微笑",
      duration: 5,
    });
    expect(result.status).toBe("queued");
    expect(result.providerTaskId).toBe("kling-task-001");
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ provider: "kling", apiKey: undefined });
    await expect(
      createKlingProvider().submit({ imagePath: "shots/test.png", prompt: "测试", duration: 5 }),
    ).rejects.toThrow("未配置可灵");
  });

  it("网络错误：fetch reject 时抛错", async () => {
    setConfig({ provider: "kling", model: "kling-3-0-omni" });
    mockFetchReject(new Error("ENOTFOUND"));
    await expect(
      createKlingProvider().submit({ imagePath: "shots/test.png", prompt: "测试", duration: 5 }),
    ).rejects.toThrow();
  });

  it("上游错误：HTTP 401 时抛错", async () => {
    setConfig({ provider: "kling", model: "kling-3-0-omni" });
    mockFetchHttpError(401, { code: 401, message: "token expired" });
    await expect(
      createKlingProvider().submit({ imagePath: "shots/test.png", prompt: "测试", duration: 5 }),
    ).rejects.toThrow();
  });
});

describe("[Video:Kling] getTask", () => {
  it("正常流程-完成：返回 done + videoPath", async () => {
    setConfig({ provider: "kling", model: "kling-3-0-omni" });
    mockFetchSuccess({
      code: 0,
      data: {
        task_status: "succeed",
        task_result: { videos: [{ url: "https://cdn.example.com/kling.mp4" }] },
      },
    });
    const result = await createKlingProvider().getTask("kling-task-001");
    expect(result.status).toBe("done");
    expect(result.result?.videoPath).toBe("videos/mock-video.mp4");
  });

  it("正常流程-处理中：返回 processing", async () => {
    setConfig({ provider: "kling", model: "kling-3-0-omni" });
    mockFetchSuccess({ code: 0, data: { task_status: "processing" } });
    const result = await createKlingProvider().getTask("kling-task-001");
    expect(result.status).toBe("processing");
  });

  it("正常流程-失败：返回 failed", async () => {
    setConfig({ provider: "kling", model: "kling-3-0-omni" });
    mockFetchSuccess({ code: 0, data: { task_status: "failed", task_status_desc: "审核未通过" } });
    const result = await createKlingProvider().getTask("kling-task-001");
    expect(result.status).toBe("failed");
  });

  it("网络错误：返回 failed handle（不抛错）", async () => {
    setConfig({ provider: "kling", model: "kling-3-0-omni" });
    mockFetchReject(new Error("socket hang up"));
    const result = await createKlingProvider().getTask("kling-task-001");
    expect(result.status).toBe("failed");
  });
});
