"use client";

/**
 * 移动端 · 任务中心
 * 卡片式任务列表（替代表格），状态筛选、流水线暂停/继续、失败重试、暂停恢复、分页。
 * 复用 /api/tasks、/api/pipeline、/api/tasks/{id}/retry、/api/tasks/{id}/resume。
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TableSkeleton } from "@/components/shared/Skeleton";

interface TaskItem {
  id: string;
  projectId: string | null;
  projectTitle: string;
  label: string | null;
  type: string;
  provider: string;
  model: string;
  status: "QUEUED" | "PROCESSING" | "DONE" | "FAILED" | "REJECTED" | "PAUSED";
  cost: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
}

const STATUS_BADGE: Record<TaskItem["status"], { text: string; cls: string }> = {
  QUEUED: { text: "排队中", cls: "bg-zinc-800 text-zinc-300" },
  PROCESSING: { text: "处理中", cls: "bg-amber-500/15 text-amber-300" },
  DONE: { text: "完成", cls: "bg-emerald-500/15 text-emerald-300" },
  FAILED: { text: "失败", cls: "bg-red-500/15 text-red-300" },
  REJECTED: { text: "已拒绝", cls: "bg-zinc-700 text-zinc-400" },
  PAUSED: { text: "已暂停", cls: "bg-orange-500/15 text-orange-300" },
};

const TYPE_LABEL: Record<string, string> = {
  LLM: "LLM",
  IMAGE: "出图",
  VIDEO: "视频",
  TTS: "配音",
  MUSIC: "音乐",
  SFX: "音效",
  COMPOSE: "合成",
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export default function MobileTasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);

  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("page", String(page));
      qs.set("pageSize", String(PAGE_SIZE));
      if (status) qs.set("status", status);
      const res = await fetch(`/api/tasks?${qs.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "加载失败");
      setTasks(body.tasks ?? []);
      setTotal(body.total ?? 0);
      if (typeof body.paused === "boolean") setPaused(body.paused);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [status, page]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), 4000);
    return () => {
      clearTimeout(t);
      clearInterval(timer);
    };
  }, [load]);

  const retry = useCallback(
    async (taskId: string) => {
      setRetrying(taskId);
      try {
        const res = await fetch(`/api/tasks/${taskId}/retry`, { method: "POST" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "重试失败");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "重试失败");
      } finally {
        setRetrying(null);
      }
    },
    [load],
  );

  const resumeTask = useCallback(
    async (taskId: string) => {
      setResuming(taskId);
      try {
        const res = await fetch(`/api/tasks/${taskId}/resume`, { method: "POST" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "恢复失败");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "恢复失败");
      } finally {
        setResuming(null);
      }
    },
    [load],
  );

  const togglePipeline = useCallback(async () => {
    if (paused === null) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/pipeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: paused ? "resume" : "pause" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "操作失败");
      setPaused(body.paused ?? !paused);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setToggling(false);
    }
  }, [paused, load]);

  const running = tasks.filter((t) => t.status === "QUEUED" || t.status === "PROCESSING").length;
  const pausedCount = tasks.filter((t) => t.status === "PAUSED").length;
  const failed = tasks.filter((t) => t.status === "FAILED" || t.status === "REJECTED").length;

  return (
    <main className="px-4 py-4">
      <header className="mb-4">
        <h1 className="text-lg font-bold">任务中心</h1>
        <p className="mt-0.5 text-[11px] text-zinc-500">全部项目的生成任务 · 每 4s 自动刷新</p>
      </header>

      {/* 状态统计 + 筛选 */}
      <div className="mb-3 flex items-center gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        <span className="shrink-0 rounded-lg bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">运行 {running}</span>
        {pausedCount > 0 && (
          <span className="shrink-0 rounded-lg bg-orange-500/10 px-2 py-1 text-[10px] text-orange-300">暂停 {pausedCount}</span>
        )}
        <span className="shrink-0 rounded-lg bg-red-500/10 px-2 py-1 text-[10px] text-red-300">失败 {failed}</span>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="ml-auto shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300"
        >
          <option value="">全部状态</option>
          <option value="QUEUED">排队中</option>
          <option value="PROCESSING">处理中</option>
          <option value="PAUSED">已暂停</option>
          <option value="DONE">完成</option>
          <option value="FAILED">失败</option>
          <option value="REJECTED">已拒绝</option>
        </select>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-[11px] text-red-300">{error}</p>
      )}

      {/* 流水线状态横幅 */}
      <section
        className={`mb-3 flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 ${
          paused ? "border-amber-700/60 bg-amber-500/10" : "border-emerald-700/60 bg-emerald-500/10"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${paused ? "bg-amber-400" : "bg-emerald-400"}`} />
          <div>
            <p className={`text-xs font-medium ${paused ? "text-amber-200" : "text-emerald-200"}`}>
              {paused === null ? "加载中…" : paused ? "流水线已暂停" : "流水线运行中"}
            </p>
            <p className={`text-[10px] ${paused ? "text-amber-300/80" : "text-emerald-300/80"}`}>
              {paused === null ? "" : paused ? "点击继续后按序处理" : "可随时暂停"}
            </p>
          </div>
        </div>
        {paused !== null && (
          <button
            onClick={() => void togglePipeline()}
            disabled={toggling}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
              paused ? "bg-amber-500" : "bg-zinc-700"
            }`}
          >
            {toggling ? "…" : paused ? "▶ 继续" : "⏸ 暂停"}
          </button>
        )}
      </section>

      {/* 任务卡片列表 */}
      {loading && tasks.length === 0 ? (
        <div className="space-y-2">
          <TableSkeleton rows={4} />
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 py-12 text-center text-xs text-zinc-500">
          暂无任务
        </div>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => {
            const badge = STATUS_BADGE[t.status];
            return (
              <li key={t.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                  <span className="text-[10px] text-zinc-500">{TYPE_LABEL[t.type] ?? t.type}</span>
                </div>
                <p className="mt-1.5 text-xs font-medium text-zinc-200 line-clamp-2">{t.label ?? `${t.provider}/${t.model}`}</p>
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500">
                  <span>{new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                  <span>
                    {fmtDuration(t.durationMs)} · {t.cost != null ? `¥${t.cost.toFixed(4)}` : "—"}
                  </span>
                </div>
                {t.projectId && (
                  <Link
                    href={`/m/projects/${t.projectId}`}
                    className="mt-1.5 block truncate text-[11px] text-violet-400 hover:underline"
                  >
                    {t.projectTitle}
                  </Link>
                )}
                {t.error && (
                  <p className="mt-1 rounded bg-red-950/30 px-1.5 py-1 text-[10px] text-red-400 line-clamp-2">{t.error}</p>
                )}
                {/* 操作 */}
                {(t.status === "FAILED" || t.status === "REJECTED" || t.status === "PAUSED") && (
                  <div className="mt-2 flex gap-1.5">
                    {(t.status === "FAILED" || t.status === "REJECTED") && (
                      <button
                        onClick={() => void retry(t.id)}
                        disabled={retrying === t.id}
                        className="flex-1 rounded-lg bg-violet-600 px-2 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
                      >
                        {retrying === t.id ? "重试中…" : "↻ 重试"}
                      </button>
                    )}
                    {t.status === "PAUSED" && (
                      <button
                        onClick={() => void resumeTask(t.id)}
                        disabled={resuming === t.id}
                        className="flex-1 rounded-lg bg-orange-600 px-2 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
                      >
                        {resuming === t.id ? "恢复中…" : "▶ 继续"}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 分页 */}
      <div className="mt-4 flex items-center justify-between text-[11px] text-zinc-500">
        <span>共 {total} 条</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-md border border-zinc-700 px-2.5 py-1 disabled:opacity-40"
          >
            ←
          </button>
          <span className="px-1">
            {page}/{totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="rounded-md border border-zinc-700 px-2.5 py-1 disabled:opacity-40"
          >
            →
          </button>
        </div>
      </div>
    </main>
  );
}
