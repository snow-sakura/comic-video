/**
 * 统一后端 API 客户端（替代原 Next.js fetch("/api/...")）
 * 开发环境 Vite 代理 /api → http://localhost:8000；
 * 生产环境读取 VITE_API_BASE 环境变量。
 */

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      // FastAPI HTTPException 返回 detail；自定义错误返回 error/message
      msg = j.error ?? j.message ?? j.detail ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  /** 项目列表（游标分页） */
  listProjects: (cursor?: string) =>
    request<{ projects: unknown[]; nextCursor?: string }>(`/api/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  /** 创建项目 */
  createProject: (title: string) =>
    request<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify({ title }) }),
  /** 删除项目 */
  deleteProjects: (ids: string[]) =>
    request("/api/projects", { method: "DELETE", body: JSON.stringify({ ids }) }),
  /** 项目详情 */
  getProject: (id: string) => request<unknown>(`/api/projects/${id}`),
  /** 项目内任务操作：retryFailed / resumePaused */
  projectTaskAction: (id: string, action: string) =>
    request(`/api/projects/${id}/tasks`, { method: "POST", body: JSON.stringify({ action }) }),
  /** 通用 */
  get: (path: string) => request(path),
  post: (path: string, body?: unknown) =>
    request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: (path: string, body?: unknown) =>
    request(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: (path: string, body?: unknown) =>
    request(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) }),
};

/**
 * 素材文件 URL（后端 GET /file?path=<storage 内相对路径>）
 * 兼容两种入库形式：
 * - 绝对路径（…/backend/storage/xxx）→ 截取 storage/ 之后的相对部分
 * - 相对路径（shots/xxx.png）→ 直接使用
 */
export function fileUrl(p: string): string {
  const rel = p.replace(/^.*?\/storage\//, "").replace(/^\/+/, "");
  return `${API_BASE}/file?path=${encodeURIComponent(rel)}`;
}
