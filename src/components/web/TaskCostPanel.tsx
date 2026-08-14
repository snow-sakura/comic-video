/**
 * 任务与费用面板（P1-2）— 展示各生成任务状态与估算费用，仅供展示不实际扣费
 * 分页：时间倒序，每页 10 条
 */
"use client";

import { useCallback, useEffect, useState } from "react";

interface GenTask {
  id: string;
  label: string | null;
  status: string;
  cost?: number | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface PageData {
  total: number;
  page: number;
  pageSize: number;
  tasks: GenTask[];
}

const PAGE_SIZE = 10;

const STATUS_STYLE: Record<string, string> = {
  DONE: "bg-emerald-500/10 text-emerald-300 border-emerald-800",
  PROCESSING: "bg-sky-500/10 text-sky-300 border-sky-800",
  QUEUED: "bg-amber-500/10 text-amber-300 border-amber-800",
  FAILED: "bg-red-500/10 text-red-300 border-red-800",
  PAUSED: "bg-orange-500/10 text-orange-300 border-orange-800",
};

const STATUS_LABEL: Record<string, string> = {
  DONE: "完成",
  PROCESSING: "处理中",
  QUEUED: "排队中",
  FAILED: "失败",
  PAUSED: "已暂停",
};

export default function TaskCostPanel({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks?page=${page}&pageSize=${PAGE_SIZE}`);
      if (!res.ok) return;
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [projectId, page]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // 自动刷新（4s 间隔）
  useEffect(() => {
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const tasks = data?.tasks ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const done = tasks.filter((t) => t.status === "DONE");
  const cost = done.reduce((s, t) => s + (typeof t.cost === "number" ? t.cost : 0), 0);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">任务与费用</h2>
        <p className="text-xs text-zinc-500">
          已用 <span className="font-mono text-emerald-300">¥{cost.toFixed(2)}</span>
          <span className="ml-1">（估算，不实际扣费）</span>
        </p>
      </div>

      {loading && tasks.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500">加载中…</p>
      ) : tasks.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-600">暂无任务</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {tasks.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${
                      STATUS_STYLE[t.status] ?? "border-zinc-700 text-zinc-400"
                    }`}
                  >
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  <span className="truncate text-zinc-200">{t.label}</span>
                  {t.error && <span className="truncate text-xs text-red-400">{t.error}</span>}
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <span className="font-mono text-xs text-zinc-400">
                    {t.status === "DONE" ? `¥${(t.cost ?? 0).toFixed(4)}` : "—"}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {t.createdAt ? new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false }) : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* 分页：时间倒序，每页 10 */}
          <div className="mt-4 flex items-center justify-between border-t border-zinc-800/70 pt-3 text-xs text-zinc-500">
            <span>
              共 {total} 条 · 每页 {PAGE_SIZE} 条 · 时间倒序
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ← 上一页
              </button>
              <span className="px-2">
                第 {page} / {totalPages} 页
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一页 →
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}