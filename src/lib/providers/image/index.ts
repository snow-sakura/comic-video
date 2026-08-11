/**
 * 图像供应商实现：智谱 CogView(默认) / 火山方舟 Seedream 5.0 / Mock
 *
 * 所有 provider 仅读取 image.* 分类配置（image.apiKey / image.model / image.baseUrl）。
 * - CogView（cogview-3-flash / glm-image）：POST {baseUrl}/images/generations
 *   返回 { data: [{ url }] }。CogView 为纯文生图，不支持多参考图，refImages 将被忽略。
 * - Seedream：支持多参考图与组图模式。
 */
import type {
  ImageGenerateOptions,
  ImageProvider,
  TaskHandle,
} from "@/lib/providers/types";
import { providerError } from "@/lib/providers/types";
import { getImageConfig, maskKey, startTimer } from "@/lib/providers/settings";
import { downloadToStorage, toDataUri, fileExists } from "@/lib/storage";

export const COGVIEW_PROVIDER_ID = "cogview";
export const SEEDREAM_PROVIDER_ID = "seedream";

// ========== 智谱 CogView ==========

/** 出图比例 → CogView 推荐尺寸 */
function cogviewSize(aspect?: string): string {
  switch (aspect) {
    case "16:9": return "1440x720";
    case "9:16": return "720x1440";
    case "3:4": return "864x1152";
    case "4:3": return "1152x864";
    case "1:1":
    default: return "1024x1024";
  }
}

export function createCogViewProvider(): ImageProvider {
  return {
    id: COGVIEW_PROVIDER_ID,
    displayName: "智谱 CogView",
    async generate(opts: ImageGenerateOptions): Promise<TaskHandle<{ imagePaths: string[] }>> {
      const cfg = await getImageConfig();
      const count = Math.max(1, opts.count ?? 1);
      const size = cogviewSize(opts.aspectRatio);
      console.log(`[image:cogview] 调用 model=${cfg.model} baseUrl=${cfg.baseUrl} key=${maskKey(cfg.apiKey)} size=${size} count=${count} refImages=${opts.refImages?.length ?? 0} prompt="${(opts.prompt ?? "").slice(0, 60)}..."`);
      const totalElapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[image:cogview] 鉴权失败：IMAGE_API_KEY 未配置 耗时=${totalElapsed()}ms`);
        throw providerError("cogview", "未配置 IMAGE_API_KEY（智谱 CogView）", "UNAUTHORIZED", false);
      }

      const imagePaths: string[] = [];
      // CogView 单次仅出 1 张，count>1 时串行多次调用
      for (let i = 0; i < count; i++) {
        const body: Record<string, unknown> = {
          model: cfg.model,
          prompt: opts.prompt,
          size,
        };
        if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;

        const url = `${cfg.baseUrl}/images/generations`;
        const elapsed = startTimer();
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
          });
        } catch (e) {
          console.error(`[image:cogview] 网络错误 url=${url} model=${cfg.model} round=${i + 1}/${count} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
          throw providerError("cogview", `图像生成网络错误: ${e instanceof Error ? e.message : String(e)}`, "UPSTREAM", true);
        }
        console.log(`[image:cogview] 响应 status=${res.status} 耗时=${elapsed()}ms round=${i + 1}/${count}`);

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          console.error(`[image:cogview] 失败 status=${res.status} url=${url} model=${cfg.model} 耗时=${elapsed()}ms body=${errText.slice(0, 300)}`);
          throw providerError(
            "cogview",
            `图像生成失败 ${res.status}: ${errText.slice(0, 300)}`,
            res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM",
            res.status >= 500
          );
        }

        const data = (await res.json()) as {
          data?: { url?: string; b64_json?: string }[];
          error?: { message?: string; code?: string };
        };
        if (data.error) {
          console.error(`[image:cogview] 上游错误 code=${data.error.code} message=${data.error.message} 耗时=${elapsed()}ms`);
          throw providerError("cogview", `图像生成失败: ${data.error.message}`, "UPSTREAM", true);
        }
        const item = data.data?.[0];
        if (!item) {
          console.error(`[image:cogview] 返回空结果 data=${JSON.stringify(data).slice(0, 200)} 耗时=${elapsed()}ms`);
          throw providerError("cogview", "图像生成返回空结果", "UPSTREAM", true);
        }
        if (item.url) {
          const category = count > 1 ? "characters" : "shots";
          imagePaths.push(await downloadToStorage(item.url, category, ".png"));
        } else if (item.b64_json) {
          // 极少数情况返回 base64
          const { saveFile } = await import("@/lib/storage");
          imagePaths.push(saveFile("shots", Buffer.from(item.b64_json, "base64"), ".png"));
        }
      }

      console.log(`[image:cogview] 成功 model=${cfg.model} count=${imagePaths.length} 总耗时=${totalElapsed()}ms`);
      return {
        taskId: `cogview-${Date.now()}`,
        status: "done",
        result: { imagePaths },
      };
    },
  };
}

// ========== 火山方舟 Seedream 5.0 ==========

const SEEDREAM_API = "https://ark.cn-beijing.volces.com/api/v3/images/generations";

export function createSeedreamProvider(): ImageProvider {
  return {
    id: SEEDREAM_PROVIDER_ID,
    displayName: "Seedream 5.0（火山方舟）",
    async generate(opts: ImageGenerateOptions): Promise<TaskHandle<{ imagePaths: string[] }>> {
      const cfg = await getImageConfig();
      const model = cfg.model || "doubao-seedream-5-0-pro-260628";
      const count = opts.count ?? 1;
      console.log(`[image:seedream] 调用 model=${model} key=${maskKey(cfg.apiKey)} size=${opts.size ?? "1K"} count=${count} refImages=${opts.refImages?.length ?? 0} prompt="${(opts.prompt ?? "").slice(0, 60)}..."`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[image:seedream] 鉴权失败：IMAGE_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw providerError("seedream", "未配置 IMAGE_API_KEY（火山方舟）", "UNAUTHORIZED", false);
      }

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

      const elapsed2 = startTimer();
      let res: Response;
      try {
        res = await fetch(SEEDREAM_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        console.error(`[image:seedream] 网络错误 url=${SEEDREAM_API} model=${model} 耗时=${elapsed2()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw providerError("seedream", `图像生成网络错误: ${e instanceof Error ? e.message : String(e)}`, "UPSTREAM", true);
      }
      console.log(`[image:seedream] 响应 status=${res.status} 耗时=${elapsed2()}ms`);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error(`[image:seedream] 失败 status=${res.status} url=${SEEDREAM_API} model=${model} 耗时=${elapsed2()}ms body=${errText.slice(0, 300)}`);
        throw providerError("seedream", `图像生成失败 ${res.status}: ${errText.slice(0, 300)}`, res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM", res.status >= 500);
      }

      const data = (await res.json()) as {
        data?: { url: string }[];
        error?: { message?: string; code?: string };
      };
      if (data.error) {
        console.error(`[image:seedream] 上游错误 code=${data.error.code} message=${data.error.message} 耗时=${elapsed2()}ms`);
        throw providerError("seedream", `图像生成失败: ${data.error.message}`, "UPSTREAM", true);
      }
      const urls = data.data?.map((d) => d.url) ?? [];
      if (urls.length === 0) {
        console.error(`[image:seedream] 返回空结果 data=${JSON.stringify(data).slice(0, 200)} 耗时=${elapsed2()}ms`);
        throw providerError("seedream", "图像生成返回空结果", "UPSTREAM", true);
      }

      const category = count > 1 ? "characters" : "shots";
      const imagePaths: string[] = [];
      for (const url of urls) {
        imagePaths.push(await downloadToStorage(url, category, ".png"));
      }

      console.log(`[image:seedream] 成功 model=${model} count=${imagePaths.length} 总耗时=${elapsed()}ms`);
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
  const cfg = await getImageConfig();
  const providerId = id ?? cfg.provider;
  if (providerId === COGVIEW_PROVIDER_ID) return createCogViewProvider();
  if (providerId === SEEDREAM_PROVIDER_ID) return createSeedreamProvider();
  return createMockImageProvider();
}
