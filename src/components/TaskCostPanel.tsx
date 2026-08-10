/**
 * 任务与费用面板（P1-2）— 展示各生成任务状态与估算费用，仅供展示不实际扣费
 */
"use client";

import { useMemo } from "react";

interface GenTask {
  id: string;
  label: string;
  status: string;
  cost?: number | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

const STATUS_STYLE: Record<string, string> = {
  DONE: "bg-emerald-500/10 text-emerald-300 border-emerald-800",
  PROCESSING: "bg-sky-500/10 text-sky-300 border-sky-800",
  QUEUED: "bg-amber-500/10 text-amber-300 border-amber-800",
  FAILED: "bg-red-500/10 text-red-300 border-red-800",
};

const STATUS_LABEL: Record<string, string> = {
  DONE: "完成",
  PROCESSING: "处理中",
  QUEUED: "排队中",
  FAILED: "失败",
};

export default function TaskCostPanel({ tasks }: { tasks: GenTask[] }) {
  const done = useMemo(() => tasks.filter((t) => t.status === "DONE"), [tasks]);
  const total = useMemo(
    () => done.reduce((s, t) => s + (typeof t.cost === "number" ? t.cost : 0), 0),
    [done]
  );

  if (tasks.length === 0) return null;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">任务与费用</h2>
        <p className="text-xs text-zinc-500">
          已用 <span className="font-mono text-emerald-300">¥{total.toFixed(2)}</span>
          <span className="ml-1">（估算，不实际扣费）</span>
        </p>
      </div>
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
            <span className="ml-3 shrink-0 font-mono text-xs text-zinc-400">
              {t.status === "DONE" ? `¥${(t.cost ?? 0).toFixed(4)}` : "—"}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
        费用按任务规模估算（LLM 按 token、出图按张、视频按条、语音按分钟）；配置 Mock
        供应商时全部记为 ¥0。
      </p>
    </section>
  );
}
