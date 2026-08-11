/**
 * 图像供应商单元测试 — 覆盖 2 个模型调用点
 *   cogview generate / seedream generate
 *
 * 每个调用点覆盖：
 *   - 正常流程（成功出图）
 *   - 鉴权失败（无 API Key）
 *   - 网络错误（fetch reject）
 *   - 上游错误（HTTP 非 200）
 *   - JSON 错误体（data.error）
 *   - 空结果（无 data.data）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ========== 模块 mock ==========

vi.mock("@/lib/providers/settings", () => ({
  getImageConfig: vi.fn(),
  maskKey: (k?: string) => (k ? `${k.slice(0, 4)}****` : "(未配置)"),
  startTimer: () => () => 42,
}));
vi.mock("@/lib/storage", () => ({
  downloadToStorage: vi.fn().mockResolvedValue("shots/mock-image.png"),
  saveFile: vi.fn().mockReturnValue("shots/mock-image.png"),
  toDataUri: vi.fn().mockReturnValue("data:image/png;base64,AAA"),
  fileExists: vi.fn().mockReturnValue(true),
}));

import { getImageConfig } from "@/lib/providers/settings";
import { downloadToStorage } from "@/lib/storage";
import { createCogViewProvider, createSeedreamProvider } from "@/lib/providers/image";

// ========== 辅助 ==========

const MOCK_KEY = "test-image-key-67890";

function setConfig(overrides: Record<string, unknown> = {}): void {
  vi.mocked(getImageConfig).mockResolvedValue({
    provider: "cogview",
    apiKey: MOCK_KEY,
    model: "cogview-3-flash",
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
  vi.mocked(downloadToStorage).mockResolvedValue("shots/mock-image.png");
  // 始终 stub fetch，使 expect(fetch).not.toHaveBeenCalled() 在鉴权测试中可用
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[Image:CogView] generate", () => {
  it("正常流程：成功出图返回路径", async () => {
    mockFetchSuccess({ data: [{ url: "https://cdn.example.com/img.png" }] });
    const result = await createCogViewProvider().generate({ prompt: "樱花树下的少女" });
    expect(result.status).toBe("done");
    expect(result.result?.imagePaths).toHaveLength(1);
    expect(downloadToStorage).toHaveBeenCalledWith("https://cdn.example.com/img.png", "shots", ".png");
  });

  it("正常流程：count=3 时串行调用 3 次", async () => {
    mockFetchSuccess({ data: [{ url: "https://cdn.example.com/img.png" }] });
    const result = await createCogViewProvider().generate({ prompt: "多角度", count: 3 });
    expect(result.result?.imagePaths).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined });
    await expect(createCogViewProvider().generate({ prompt: "测试" })).rejects.toThrow("未配置 IMAGE_API_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("网络错误：fetch reject 时抛错并记录日志", async () => {
    mockFetchReject(new Error("ECONNREFUSED"));
    await expect(createCogViewProvider().generate({ prompt: "测试" })).rejects.toThrow("网络错误");
  });

  it("上游错误：HTTP 401 时抛错", async () => {
    mockFetchHttpError(401, { error: "unauthorized" });
    await expect(createCogViewProvider().generate({ prompt: "测试" })).rejects.toThrow("401");
  });

  it("JSON 错误体：data.error 存在时抛错", async () => {
    mockFetchSuccess({ error: { code: "RATE_LIMIT", message: "请求过于频繁" } });
    await expect(createCogViewProvider().generate({ prompt: "测试" })).rejects.toThrow("请求过于频繁");
  });

  it("空结果：data.data 为空时抛错", async () => {
    mockFetchSuccess({ data: [] });
    await expect(createCogViewProvider().generate({ prompt: "测试" })).rejects.toThrow("空结果");
  });
});

describe("[Image:Seedream] generate", () => {
  it("正常流程：成功出图返回路径", async () => {
    mockFetchSuccess({ data: [{ url: "https://cdn.example.com/seed.png" }] });
    const result = await createSeedreamProvider().generate({ prompt: "角色定妆照", refImages: [] });
    expect(result.status).toBe("done");
    expect(result.result?.imagePaths).toHaveLength(1);
  });

  it("正常流程：多 URL 返回多图", async () => {
    mockFetchSuccess({
      data: [
        { url: "https://cdn.example.com/a.png" },
        { url: "https://cdn.example.com/b.png" },
        { url: "https://cdn.example.com/c.png" },
      ],
    });
    const result = await createSeedreamProvider().generate({ prompt: "三连图", count: 3 });
    expect(result.result?.imagePaths).toHaveLength(3);
  });

  it("鉴权失败：无 API Key 时抛错", async () => {
    setConfig({ apiKey: undefined, provider: "seedream" });
    await expect(createSeedreamProvider().generate({ prompt: "测试" })).rejects.toThrow("未配置 IMAGE_API_KEY");
  });

  it("网络错误：fetch reject 时抛错", async () => {
    mockFetchReject(new Error("DNS 解析失败"));
    await expect(createSeedreamProvider().generate({ prompt: "测试" })).rejects.toThrow("网络错误");
  });

  it("上游错误：HTTP 500 时抛错", async () => {
    mockFetchHttpError(500, { error: "internal" });
    await expect(createSeedreamProvider().generate({ prompt: "测试" })).rejects.toThrow("500");
  });

  it("JSON 错误体：data.error 存在时抛错", async () => {
    mockFetchSuccess({ error: { code: "INVALID_PARAM", message: "参数错误" } });
    await expect(createSeedreamProvider().generate({ prompt: "测试" })).rejects.toThrow("参数错误");
  });

  it("空结果：data.data 为空时抛错", async () => {
    mockFetchSuccess({ data: [] });
    await expect(createSeedreamProvider().generate({ prompt: "测试" })).rejects.toThrow("空结果");
  });
});
