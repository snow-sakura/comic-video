/**
 * 视频供应商实现：智谱 CogVideoX(默认,异步轮询) / 可灵 Kling 3.0 Omni / Mock
 *
 * 所有 provider 仅读取 video.* 分类配置（video.apiKey / video.secret / video.model / video.baseUrl）。
 * - CogVideoX：POST {baseUrl}/videos/generations 提交 → GET {baseUrl}/async-result/{id} 轮询。
 *   支持图生视频（image_url 传 base64）。
 * - 可灵：JWT 鉴权（AK+SK），图生视频异步任务。
 */
import { createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type {
  TaskHandle,
  VideoGenerateOptions,
  VideoProvider,
} from "@/lib/providers/types";
import { providerError } from "@/lib/providers/types";
import { getVideoConfig, maskKey, startTimer } from "@/lib/providers/settings";
import { absPath, downloadToStorage, saveFile, fileExists } from "@/lib/storage";

export const COGVIDEOX_PROVIDER_ID = "cogvideox";
export const KLING_PROVIDER_ID = "kling";
export const VIDU_PROVIDER_ID = "vidu";

// ========== 智谱 CogVideoX ==========

/** 出图比例 → CogVideoX 尺寸 */
function cogvideoxSize(aspect?: string): string {
  switch (aspect) {
    case "16:9": return "1920x1080";
    case "9:16": return "1080x1920";
    case "1:1":
    default: return "1024x1024";
  }
}

export function createCogVideoXProvider(): VideoProvider {
  async function authHeaders(apiKey: string): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
  }

  return {
    id: COGVIDEOX_PROVIDER_ID,
    displayName: "智谱 CogVideoX",
    async submit(opts: VideoGenerateOptions): Promise<TaskHandle> {
      const cfg = await getVideoConfig();
      const size = cogvideoxSize(opts.aspectRatio);
      const duration = opts.duration ?? 5;
      console.log(`[video:cogvideox] 提交 model=${cfg.model} baseUrl=${cfg.baseUrl} key=${maskKey(cfg.apiKey)} size=${size} duration=${duration} image="${opts.imagePath}" prompt="${(opts.prompt ?? "").slice(0, 60)}..."`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[video:cogvideox] 鉴权失败：VIDEO_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw providerError("cogvideox", "未配置 VIDEO_API_KEY（智谱 CogVideoX）", "UNAUTHORIZED", false);
      }

      // 分镜图 → base64
      if (!fileExists(opts.imagePath)) {
        console.error(`[video:cogvideox] 参数错误：分镜图不存在 ${opts.imagePath} 耗时=${elapsed()}ms`);
        throw providerError("cogvideox", `分镜图不存在: ${opts.imagePath}`, "INVALID_REQUEST", false);
      }
      const imgAbs = absPath(opts.imagePath);
      const stat = statSync(imgAbs);
      if (stat.size > 5 * 1024 * 1024) {
        console.error(`[video:cogvideox] 参数错误：图片 ${stat.size} 字节超过 5MB 耗时=${elapsed()}ms`);
        throw providerError("cogvideox", "图片超过 5MB 限制", "INVALID_REQUEST", false);
      }
      const imageB64 = readFileSync(imgAbs).toString("base64");
      console.log(`[video:cogvideox] 分镜图已读取 size=${stat.size}字节 b64=${imageB64.length}字符 耗时=${elapsed()}ms`);

      const headers = await authHeaders(cfg.apiKey);
      const body: Record<string, unknown> = {
        model: cfg.model,
        prompt: (opts.prompt ?? "").slice(0, 512),
        image_url: imageB64,
        duration,
        quality: "speed",
        with_audio: false,
        size,
        // fps 默认 30
      };

      const url = `${cfg.baseUrl}/videos/generations`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (e) {
        console.error(`[video:cogvideox] 提交网络错误 url=${url} model=${cfg.model} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw providerError("cogvideox", `视频提交网络错误: ${e instanceof Error ? e.message : String(e)}`, "UPSTREAM", true);
      }
      const json = (await res.json().catch(() => ({}))) as {
        id?: string;
        task_status?: string;
        error?: { code?: string; message?: string };
      };
      if (!res.ok || json.error) {
        console.error(`[video:cogvideox] 提交失败 status=${res.status} url=${url} model=${cfg.model} 耗时=${elapsed()}ms error=${json.error?.message ?? res.statusText} code=${json.error?.code ?? ""}`);
        throw providerError(
          "cogvideox",
          `CogVideoX 提交失败: ${json.error?.message ?? res.statusText}`,
          res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM",
          res.status >= 500
        );
      }
      const taskId = json.id;
      if (!taskId) {
        console.error(`[video:cogvideox] 未返回任务 id resp=${JSON.stringify(json).slice(0, 200)} 耗时=${elapsed()}ms`);
        throw providerError("cogvideox", "CogVideoX 未返回任务 id", "UPSTREAM", true);
      }
      console.log(`[video:cogvideox] 提交成功 providerTaskId=${taskId} status=${json.task_status ?? "PROCESSING"} 耗时=${elapsed()}ms`);
      return {
        taskId: `cogvideox-${Date.now()}`,
        providerTaskId: taskId,
        status: "queued",
      };
    },

    async getTask(providerTaskId: string): Promise<TaskHandle<{ videoPath: string }>> {
      const cfg = await getVideoConfig();
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[video:cogvideox] 鉴权失败：VIDEO_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw providerError("cogvideox", "未配置 VIDEO_API_KEY（智谱 CogVideoX）", "UNAUTHORIZED", false);
      }
      const headers = await authHeaders(cfg.apiKey);

      const url = `${cfg.baseUrl}/async-result/${providerTaskId}`;
      let res: Response;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        console.error(`[video:cogvideox] 轮询网络错误 url=${url} id=${providerTaskId} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        return {
          taskId: `cogvideox-${Date.now()}`,
          providerTaskId,
          status: "failed",
          error: `轮询网络错误: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const json = (await res.json().catch(() => ({}))) as {
        task_status?: string;
        video_result?: { url?: string; cover_image_url?: string }[];
        error?: { message?: string };
      };
      if (!res.ok || json.error) {
        console.error(`[video:cogvideox] 轮询失败 status=${res.status} id=${providerTaskId} 耗时=${elapsed()}ms error=${json.error?.message ?? "查询失败"}`);
        return {
          taskId: `cogvideox-${Date.now()}`,
          providerTaskId,
          status: "failed",
          error: json.error?.message ?? "查询失败",
        };
      }
      const status = (json.task_status ?? "").toUpperCase();
      console.log(`[video:cogvideox] 轮询 id=${providerTaskId} status=${status} 耗时=${elapsed()}ms`);
      if (status === "SUCCESS") {
        const vurl = json.video_result?.[0]?.url;
        if (!vurl) {
          console.error(`[video:cogvideox] 成功但无视频结果 resp=${JSON.stringify(json).slice(0, 200)} 耗时=${elapsed()}ms`);
          return { taskId: providerTaskId, providerTaskId, status: "failed", error: "无视频结果" };
        }
        const videoPath = await downloadToStorage(vurl, "videos", ".mp4");
        console.log(`[video:cogvideox] 完成 id=${providerTaskId} video=${videoPath} 耗时=${elapsed()}ms`);
        return { taskId: providerTaskId, providerTaskId, status: "done", result: { videoPath } };
      }
      if (status === "FAIL") {
        console.error(`[video:cogvideox] 生成失败 id=${providerTaskId} resp=${JSON.stringify(json).slice(0, 200)} 耗时=${elapsed()}ms`);
        return {
          taskId: providerTaskId,
          providerTaskId,
          status: "failed",
          error: "CogVideoX 生成失败",
        };
      }
      return { taskId: providerTaskId, providerTaskId, status: "processing" };
    },
  };
}

// ========== 可灵 Kling ==========

const KLING_API_BASE = "https://api-beijing.klingai.com";

// JWT 签名（HS256，避免引入 jsonwebtoken 依赖）
function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signKlingJwt(accessKey: string, secretKey: string, ttlSeconds = 1800): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: accessKey, exp: now + ttlSeconds, nbf: now - 5 })
  );
  const sig = createHmac("sha256", secretKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function createKlingProvider(): VideoProvider {
  async function authHeaders(elapsed: () => number): Promise<Record<string, string>> {
    const cfg = await getVideoConfig();
    if (!cfg.apiKey || !cfg.secret) {
      console.error(`[video:kling] 鉴权失败：未配置可灵 AccessKey/SecretKey key=${maskKey(cfg.apiKey)} secret=${maskKey(cfg.secret)} 耗时=${elapsed()}ms`);
      throw providerError("kling", "未配置可灵 AccessKey/SecretKey（VIDEO_API_KEY / VIDEO_SECRET）", "UNAUTHORIZED", false);
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signKlingJwt(cfg.apiKey, cfg.secret)}`,
    };
  }

  return {
    id: KLING_PROVIDER_ID,
    displayName: "可灵 Kling 3.0 Omni",
    async submit(opts: VideoGenerateOptions): Promise<TaskHandle> {
      const cfg = await getVideoConfig();
      const model = cfg.model || "kling-v3-0-omni";
      const duration = opts.duration ?? 5;
      console.log(`[video:kling] 提交 model=${model} key=${maskKey(cfg.apiKey)} secret=${maskKey(cfg.secret)} duration=${duration} image="${opts.imagePath}" refImages=${opts.refImages?.length ?? 0}`);
      const elapsed = startTimer();
      const headers = await authHeaders(elapsed);

      // 分镜图 → base64（无 data: 前缀，≤10MB）
      const imagePath = absPath(opts.imagePath);
      if (!fileExists(opts.imagePath)) {
        console.error(`[video:kling] 参数错误：分镜图不存在 ${opts.imagePath} 耗时=${elapsed()}ms`);
        throw providerError("kling", `分镜图不存在: ${opts.imagePath}`, "INVALID_REQUEST", false);
      }
      const stat = statSync(imagePath);
      if (stat.size > 10 * 1024 * 1024) {
        console.error(`[video:kling] 参数错误：图片 ${stat.size} 字节超过 10MB 耗时=${elapsed()}ms`);
        throw providerError("kling", "图片超过 10MB 限制", "INVALID_REQUEST", false);
      }
      const imageB64 = readFileSync(imagePath).toString("base64");

      // 参考主体图（可灵 Omni 角色一致性）
      const refImages = opts.refImages ?? [];
      let prompt = opts.prompt ?? "";
      if (refImages.length > 0) {
        const refB64s = refImages
          .slice(0, 3)
          .map((p) => (fileExists(p) ? readFileSync(absPath(p)).toString("base64") : ""))
          .filter(Boolean);
        if (refB64s.length > 0) {
          prompt = `${prompt} 保持参考图${refB64s
            .map((_, i) => `<<<image_${i + 1}>>>`)
            .join("、")}中的人物形象一致`;
          void refB64s;
        }
      }

      const body: Record<string, unknown> = {
        model_name: model,
        image: imageB64,
        prompt: prompt.slice(0, 2500),
        duration: String(duration),
        mode: "std",
        watermark_info: { enabled: false },
      };

      const url = `${KLING_API_BASE}/v1/videos/image2video`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (e) {
        console.error(`[video:kling] 提交网络错误 url=${url} model=${model} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw providerError("kling", `可灵提交网络错误: ${e instanceof Error ? e.message : String(e)}`, "UPSTREAM", true);
      }
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        message?: string;
        data?: { task_id?: string; task_status?: string };
      };
      if (!res.ok || json.code !== 0) {
        console.error(`[video:kling] 提交失败 status=${res.status} url=${url} model=${model} 耗时=${elapsed()}ms code=${json.code ?? ""} message=${json.message ?? res.statusText}`);
        throw providerError(
          "kling",
          `可灵提交失败: ${json.message ?? res.statusText}`,
          res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM",
          res.status >= 500
        );
      }
      const taskId = json.data?.task_id;
      if (!taskId) {
        console.error(`[video:kling] 未返回 task_id resp=${JSON.stringify(json).slice(0, 200)} 耗时=${elapsed()}ms`);
        throw providerError("kling", "可灵未返回 task_id", "UPSTREAM", true);
      }
      console.log(`[video:kling] 提交成功 providerTaskId=${taskId} status=${json.data?.task_status ?? ""} 耗时=${elapsed()}ms`);
      return {
        taskId: `kling-${Date.now()}`,
        providerTaskId: taskId,
        status: "queued",
      };
    },

    async getTask(providerTaskId: string): Promise<TaskHandle<{ videoPath: string }>> {
      const elapsed = startTimer();
      const headers = await authHeaders(elapsed);
      const url = `${KLING_API_BASE}/v1/videos/image2video/${providerTaskId}`;
      let res: Response;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        console.error(`[video:kling] 轮询网络错误 url=${url} id=${providerTaskId} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        return {
          taskId: `kling-${Date.now()}`,
          providerTaskId,
          status: "failed",
          error: `轮询网络错误: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        message?: string;
        data?: {
          task_status?: string;
          task_result?: { videos?: { url?: string }[]; failure_reason?: string };
        };
      };
      if (!res.ok || json.code !== 0) {
        console.error(`[video:kling] 轮询失败 status=${res.status} id=${providerTaskId} 耗时=${elapsed()}ms code=${json.code ?? ""} message=${json.message ?? "查询失败"}`);
        return {
          taskId: `kling-${Date.now()}`,
          providerTaskId,
          status: "failed",
          error: json.message ?? "查询失败",
        };
      }
      const status = json.data?.task_status;
      console.log(`[video:kling] 轮询 id=${providerTaskId} status=${status ?? "?"} 耗时=${elapsed()}ms`);
      if (status === "succeed") {
        const vurl = json.data?.task_result?.videos?.[0]?.url;
        if (!vurl) {
          console.error(`[video:kling] 成功但无视频结果 resp=${JSON.stringify(json).slice(0, 200)} 耗时=${elapsed()}ms`);
          return { taskId: providerTaskId, providerTaskId, status: "failed", error: "无视频结果" };
        }
        const videoPath = await downloadToStorage(vurl, "videos", ".mp4");
        console.log(`[video:kling] 完成 id=${providerTaskId} video=${videoPath} 耗时=${elapsed()}ms`);
        return { taskId: providerTaskId, providerTaskId, status: "done", result: { videoPath } };
      }
      if (status === "failed") {
        console.error(`[video:kling] 生成失败 id=${providerTaskId} 耗时=${elapsed()}ms reason=${json.data?.task_result?.failure_reason ?? ""}`);
        return {
          taskId: providerTaskId,
          providerTaskId,
          status: "failed",
          error: json.data?.task_result?.failure_reason ?? "生成失败",
        };
      }
      return { taskId: providerTaskId, providerTaskId, status: "processing" };
    },
  };
}

// ========== Mock ==========

export function createMockVideoProvider(): VideoProvider {
  return {
    id: "mock-video",
    displayName: "Mock 视频（无Key演示）",
    async submit(opts: VideoGenerateOptions): Promise<TaskHandle> {
      const videoPath = await createPlaceholderVideo(opts.duration ?? 5);
      return {
        taskId: `mock-video-${Date.now()}`,
        providerTaskId: `mock-${Date.now()}`,
        status: "done",
        result: { videoPath },
      };
    },
    async getTask(): Promise<TaskHandle<{ videoPath: string }>> {
      return { taskId: "", status: "processing" };
    },
  };
}

async function createPlaceholderVideo(duration: number): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { uniqueName } = await import("@/lib/storage");
  const { path, relPath } = uniqueName("videos", ".mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "color=c=0x2a2a4a:s=1280x720:d=" + duration,
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=" + duration,
      "-shortest",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-c:a", "aac",
      "-y", path,
    ]);
    return relPath;
  } catch {
    // ffmpeg 不可用：写一个假文件（演示模式）
    return saveFile("videos", Buffer.from("mock-video"), ".mp4");
  }
}

// ========== 工厂 ==========

export async function createVideoProvider(id?: string): Promise<VideoProvider> {
  const cfg = await getVideoConfig();
  const providerId = id ?? cfg.provider;
  if (providerId === COGVIDEOX_PROVIDER_ID) return createCogVideoXProvider();
  if (providerId === KLING_PROVIDER_ID) return createKlingProvider();
  if (providerId === VIDU_PROVIDER_ID) {
    // Vidu 适配器占位（文档确认后实现；当前回退 Mock 并提示）
    return createMockVideoProvider();
  }
  return createMockVideoProvider();
}
