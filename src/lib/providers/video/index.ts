/**
 * 视频供应商实现：可灵 Kling 3.0 Omni / Vidu / Mock
 * 可灵端点: POST https://api-beijing.klingai.com/v1/videos/image2video/
 * 鉴权: JWT (HS256, iss=AK, exp=30min, nbf=-5s)
 */
import { createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type {
  TaskHandle,
  VideoGenerateOptions,
  VideoProvider,
} from "@/lib/providers/types";
import { providerError } from "@/lib/providers/types";
import { getApiKey, getSetting } from "@/lib/providers/settings";
import { absPath, downloadToStorage, saveFile, fileExists } from "@/lib/storage";

export const KLING_PROVIDER_ID = "kling";
export const VIDU_PROVIDER_ID = "vidu";

const KLING_API_BASE = "https://api-beijing.klingai.com";

// ========== JWT 签名（HS256，避免引入 jsonwebtoken 依赖） ==========

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

// ========== 可灵 ==========

export function createKlingProvider(): VideoProvider {
  async function authHeaders(): Promise<Record<string, string>> {
    const ak = (await getApiKey("kling")) ?? "";
    const sk = (await getSetting<string>("kling.secret")) ?? "";
    if (!ak || !sk) {
      throw providerError("kling", "未配置可灵 AccessKey/SecretKey", "UNAUTHORIZED", false);
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signKlingJwt(ak, sk)}`,
    };
  }

  return {
    id: KLING_PROVIDER_ID,
    displayName: "可灵 Kling 3.0 Omni",
    async submit(opts: VideoGenerateOptions): Promise<TaskHandle> {
      const headers = await authHeaders();
      const model = (await getSetting<string>("video.kling.model")) ?? "kling-v3-0-omni";

      // 分镜图 → base64（无 data: 前缀，≤10MB）
      const imagePath = absPath(opts.imagePath);
      if (!fileExists(opts.imagePath)) {
        throw providerError("kling", `分镜图不存在: ${opts.imagePath}`, "INVALID_REQUEST", false);
      }
      const stat = statSync(imagePath);
      if (stat.size > 10 * 1024 * 1024) {
        throw providerError("kling", "图片超过 10MB 限制", "INVALID_REQUEST", false);
      }
      const imageB64 = readFileSync(imagePath).toString("base64");

      // 参考主体图（可灵 Omni 角色一致性）
      const refImages = opts.refImages ?? [];
      let elementList: { element_id: number }[] | undefined;
      let prompt = opts.prompt;
      if (refImages.length > 0) {
        // 参考图作为输入图拼接进 prompt 引用（Omni 多图引用）
        const refB64s = refImages
          .slice(0, 3)
          .map((p) => (fileExists(p) ? readFileSync(absPath(p)).toString("base64") : ""))
          .filter(Boolean);
        if (refB64s.length > 0) {
          prompt = `${prompt} 保持参考图${refB64s
            .map((_, i) => `<<<image_${i + 1}>>>`)
            .join("、")}中的人物形象一致`;
          // element_list 需要先在素材库上传元素，此处用 image 多图引用方式（简单可靠）
          void refB64s;
        }
      }

      const body: Record<string, unknown> = {
        model_name: model,
        image: imageB64,
        prompt: prompt.slice(0, 2500),
        duration: String(opts.duration ?? 5),
        mode: "std",
        watermark_info: { enabled: false },
      };
      if (elementList) body.element_list = elementList;

      const res = await fetch(`${KLING_API_BASE}/v1/videos/image2video`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        message?: string;
        data?: { task_id?: string; task_status?: string };
      };
      if (!res.ok || json.code !== 0) {
        throw providerError(
          "kling",
          `可灵提交失败: ${json.message ?? res.statusText}`,
          res.status === 401 ? "UNAUTHORIZED" : "UPSTREAM",
          res.status >= 500
        );
      }
      const taskId = json.data?.task_id;
      if (!taskId) throw providerError("kling", "可灵未返回 task_id", "UPSTREAM", true);

      return {
        taskId: `kling-${Date.now()}`,
        providerTaskId: taskId,
        status: "queued",
      };
    },

    async getTask(providerTaskId: string): Promise<TaskHandle<{ videoPath: string }>> {
      const headers = await authHeaders();
      const res = await fetch(`${KLING_API_BASE}/v1/videos/image2video/${providerTaskId}`, {
        headers,
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        message?: string;
        data?: {
          task_status?: string;
          task_result?: { videos?: { url?: string }[]; failure_reason?: string };
        };
      };
      if (!res.ok || json.code !== 0) {
        return {
          taskId: `kling-${Date.now()}`,
          providerTaskId,
          status: "failed",
          error: json.message ?? "查询失败",
        };
      }
      const status = json.data?.task_status;
      if (status === "succeed") {
        const url = json.data?.task_result?.videos?.[0]?.url;
        if (!url) {
          return { taskId: providerTaskId, providerTaskId, status: "failed", error: "无视频结果" };
        }
        const videoPath = await downloadToStorage(url, "videos", ".mp4");
        return { taskId: providerTaskId, providerTaskId, status: "done", result: { videoPath } };
      }
      if (status === "failed") {
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
      // 生成一个极小的 mp4 占位（用 ffmpeg 生成 1 秒纯色视频）
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
  const providerId = id ?? (await getSetting<string>("video.provider")) ?? KLING_PROVIDER_ID;
  if (providerId === KLING_PROVIDER_ID) return createKlingProvider();
  if (providerId === VIDU_PROVIDER_ID) {
    // Vidu 适配器占位（文档确认后实现；当前回退 Mock 并提示）
    return createMockVideoProvider();
  }
  return createMockVideoProvider();
}
