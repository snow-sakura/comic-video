"use client";

/**
 * 任务中心（P1-7）：跨项目全局任务视图
 * 表格：时间 / 项目 / 任务 / 状态 / 耗时 / 费用 / 操作（失败可重试）
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface TaskItem {
  id: string;
  projectId: string | null;
  projectTitle: string;
  label: string | null;
  type: string;
  provider: string;
  model: string;
  status: "QUEUED" | "PROCESSING" | "DONE" | "FAILED" | "REJECTED";
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

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = status ? `?status=${status}` : "";
      const res = await fetch(`/api/tasks${qs}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "加载失败");
      setTasks(body.tasks ?? []);
      setTotal(body.total ?? 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
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

  const running = tasks.filter((t) => t.status === "QUEUED" || t.status === "PROCESSING").length;
  const failed = tasks.filter((t) => t.status === "FAILED" || t.status === "REJECTED").length;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-zinc-500 transition hover:text-zinc-300">← 返回</Link>
          <h1 className="text-xl font-bold">任务中心</h1>
          <span className="text-xs text-zinc-500">全部项目的生成任务</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-lg bg-amber-500/10 px-2.5 py-1 text-amber-300">运行中 {running}</span>
          <span className="rounded-lg bg-red-500/10 px-2.5 py-1 text-red-300">失败 {failed}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300"
          >
            <option value="">全部状态</option>
            <option value="QUEUED">排队中</option>
            <option value="PROCESSING">处理中</option>
            <option value="DONE">完成</option>
            <option value="FAILED">失败</option>
            <option value="REJECTED">已拒绝</option>
          </select>
        </div>
      </header>

      {error && (
        <p className="mb-3 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2.5 font-medium">创建时间</th>
                <th className="px-3 py-2.5 font-medium">项目</th>
                <th className="px-3 py-2.5 font-medium">任务</th>
                <th className="px-3 py-2.5 font-medium">类型</th>
                <th className="px-3 py-2.5 font-medium">状态</th>
                <th className="px-3 py-2.5 font-medium">耗时</th>
                <th className="px-3 py-2.5 font-medium">费用</th>
                <th className="px-3 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {loading && tasks.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-zinc-500">加载中…</td></tr>
              ) : tasks.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-zinc-500">暂无任务</td></tr>
              ) : (
                tasks.map((t) => {
                  const badge = STATUS_BADGE[t.status];
                  return (
                    <tr key={t.id} className="hover:bg-zinc-900/40">
                      <td className="whitespace-nowrap px-3 py-2.5 text-zinc-400">
                        {new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false })}
                      </td>
                      <td className="max-w-36 truncate px-3 py-2.5 text-zinc-300">
                        {t.projectId ? (
                          <Link href={`/projects/${t.projectId}`} className="hover:text-violet-300 hover:underline">
                            {t.projectTitle}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="max-w-64 truncate px-3 py-2.5 text-zinc-200" title={t.label ?? ""}>
                        {t.label ?? `${t.provider}/${t.model}`}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-400">{TYPE_LABEL[t.type] ?? t.type}</td>
                      <td className="px-3 py-2.5">
                        <span className={`rounded-md px-2 py-0.5 ${badge.cls}`}>{badge.text}</span>
                        {t.error && (
                          <p className="mt-1 max-w-56 truncate text-[10px] text-red-400" title={t.error}>
                            {t.error.slice(0, 60)}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-400">{fmtDuration(t.durationMs)}</td>
                      <td className="px-3 py-2.5 text-zinc-300">
                        {t.cost != null ? `¥${t.cost.toFixed(4)}` : "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        {(t.status === "FAILED" || t.status === "REJECTED") && (
                          <button
                            onClick={() => void retry(t.id)}
                            disabled={retrying === t.id}
                            className="rounded-md bg-violet-600/80 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
                          >
                            {retrying === t.id ? "重试中…" : "重试"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-3 text-right text-xs text-zinc-600">共 {total} 条 · 每 4s 自动刷新</p>
    </main>
  );
}
