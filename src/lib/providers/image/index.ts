/**
 * 图像供应商实现：Seedream 5.0（火山方舟）/ Mock
 * Seedream 5.0 pro 支持：文生图、多参考图生图（2-10张）、组图模式
 * 端点: POST https://ark.cn-beijing.volces.com/api/v3/images/generations
 */
import type {
  ImageGenerateOptions,
  ImageProvider,
  TaskHandle,
  ProviderError,
} from "@/lib/providers/types";
import { providerError } from "@/lib/providers/types";
import { getApiKey, getSetting } from "@/lib/providers/settings";
import { downloadToStorage, toDataUri, fileExists } from "@/lib/storage";

export const SEEDREAM_PROVIDER_ID = "seedream";

const API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";

export function createSeedreamProvider(): ImageProvider {
  return {
    id: SEEDREAM_PROVIDER_ID,
    displayName: "Seedream 5.0（火山方舟）",
    async generate(opts: ImageGenerateOptions): Promise<TaskHandle<{ imagePaths: string[] }>> {
      const apiKey = (await getApiKey("ark")) ?? "";
      if (!apiKey) throw providerError("seedream", "未配置火山方舟 API Key", "UNAUTHORIZED", false);
      const model = (await getSetting<string>("image.seedream.model")) ?? "doubao-seedream-5-0-pro-260628";

      // 参考图：本地文件 → data URI
      const refImages: string[] = [];
      for (const ref of opts.refImages ?? []) {
        if (ref.startsWith("http")) {
          refImages.push(ref);
        } else if (fileExists(ref)) {
          const mime = ref.endsWith(".jpg") || ref.endsWith(".jpeg") ? "image/jpeg" : "image/png";
          refImages.push(toDataUri(ref, mime));
        }
      }

      const count = opts.count ?? 1;
      const body: Record<string, unknown> = {
        model,
        prompt: opts.prompt,
        size: opts.size === "2K" ? "2K" : "1K",
        watermark: false,
        response_format: "url",
        ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
      };
      if (refImages.length > 0) {
        body.image = refImages.length === 1 ? refImages[0] : refImages;
      }
      // 组图模式（一次生成多张相关图，用于定妆照多角度）
      if (count > 1) {
        body.sequential_image_generation = "auto";
      }

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw providerError("seedream", `图像生成失败 ${res.status}: ${errText.slice(0, 300)}`, res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM", res.status >= 500);
      }

      const data = (await res.json()) as {
        data?: { url: string }[];
        error?: { message?: string; code?: string };
      };
      if (data.error) {
        throw providerError("seedream", `图像生成失败: ${data.error.message}`, "UPSTREAM", true);
      }
      const urls = data.data?.map((d) => d.url) ?? [];
      if (urls.length === 0) {
        throw providerError("seedream", "图像生成返回空结果", "UPSTREAM", true);
      }

      // 下载到本地存储
      const category = count > 1 ? "characters" : "shots";
      const imagePaths: string[] = [];
      for (const url of urls) {
        imagePaths.push(await downloadToStorage(url, category, ".png"));
      }

      return {
        taskId: `seedream-${Date.now()}`,
        status: "done",
        result: { imagePaths },
      };
    },
  };
}

// ========== Mock ==========

export function createMockImageProvider(): ImageProvider {
  return {
    id: "mock-image",
    displayName: "Mock 图像（无Key演示）",
    async generate(opts: ImageGenerateOptions): Promise<TaskHandle<{ imagePaths: string[] }>> {
      // 生成纯色占位 PNG（1x1），保证流程可跑
      const count = opts.count ?? 1;
      const imagePaths: string[] = [];
      for (let i = 0; i < count; i++) {
        imagePaths.push(await createPlaceholderPng(opts.aspectRatio ?? "1:1", i));
      }
      return { taskId: `mock-img-${Date.now()}`, status: "done", result: { imagePaths } };
    },
  };
}

/** 生成占位 PNG（本地无 canvas 依赖，手写最小 PNG 编码） */
async function createPlaceholderPng(aspect: string, seed: number): Promise<string> {
  const [w, h] = aspect.split(":").map(Number);
  const width = Math.min(64, Math.round(64 * (w / h)));
  const height = 64;
  // 简单纯色 PNG（64x64），使用 node zlib 构造
  const { deflateSync } = await import("node:zlib");
  const colors = [
    [0x8e, 0x5f, 0x9e],
    [0x4a, 0x90, 0xd9],
    [0xe6, 0x7e, 0x22],
    [0x27, 0xae, 0x60],
  ];
  const c = colors[seed % colors.length];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const off = y * (width * 3 + 1) + 1 + x * 3;
      raw[off] = c[0];
      raw[off + 1] = c[1];
      raw[off + 2] = c[2];
    }
  }
  const idat = deflateSync(raw);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type);
    const crcTable = crcTableBuilder();
    const crc = crc32(typeBuf, crcTable, crc32(data, crcTable, 0));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const { saveFile } = await import("@/lib/storage");
  return saveFile("shots", png, ".png");
}

// 简单 CRC32（PNG 需要）
function crcTableBuilder(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf: Buffer, table: Uint32Array, seed: number): number {
  let c = seed ^ 0xffffffff;
  for (const b of buf) {
    c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ========== 工厂 ==========

export async function createImageProvider(id?: string): Promise<ImageProvider> {
  const providerId = id ?? (await getSetting<string>("image.provider")) ?? SEEDREAM_PROVIDER_ID;
  if (providerId === SEEDREAM_PROVIDER_ID) return createSeedreamProvider();
  return createMockImageProvider();
}
