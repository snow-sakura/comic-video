"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ProjectCardSkeleton } from "@/components/shared/Skeleton";
import {
  type Project,
  inferSteps,
  inferExecState,
  EXEC_LABEL,
  EXEC_COLOR,
  EXEC_DOT,
} from "@/components/shared/project-utils";

// ========== 页面组件 ==========

export default function MobileHomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects ?? data);
        setNextCursor(data.nextCursor ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/projects?cursor=${encodeURIComponent(nextCursor)}`);
      if (res.ok) {
        const data = await res.json();
        setProjects((prev) => [...prev, ...(data.projects ?? [])]);
        setNextCursor(data.nextCursor ?? null);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const hasRunning = projects.some((p) => inferExecState(p) === "RUNNING");

  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void loadProjects(), 3000);
    return () => clearInterval(timer);
  }, [hasRunning, loadProjects]);

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`确定删除选中的 ${selected.size} 个项目？\n将同时删除剧本、角色、场景、道具、分镜、任务等全部关联数据，且不可恢复。`)) {
      return;
    }
    setDeleting(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "删除失败");
        return;
      }
      setSelecting(false);
      setSelected(new Set());
      await loadProjects();
    } catch {
      setError("网络错误");
    } finally {
      setDeleting(false);
    }
  }

  async function createProject() {
    if (creating || !title.trim()) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "创建失败");
        return;
      }
      const p = (await res.json()) as Project;
      router.push(`/m/projects/${p.id}`);
    } catch {
      setError("网络错误");
    } finally {
      setCreating(false);
    }
  }

  async function projectAction(projectId: string, action: "retryFailed" | "resumePaused") {
    setActing(projectId);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "操作失败");
        return;
      }
      await loadProjects();
    } catch {
      setError("网络错误");
    } finally {
      setActing(null);
    }
  }

  return (
    <main className="px-4 py-5">
      {/* 头部 */}
      <header className="mb-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">AI 漫剧工坊</h1>
            <p className="mt-0.5 text-xs text-zinc-500">小说 → 剧本 → 资产 → 分镜 → 视频</p>
          </div>
          <div className="flex items-center gap-1.5">
            {selecting ? (
              <>
                <button
                  onClick={() =>
                    setSelected(
                      selected.size === projects.length ? new Set() : new Set(projects.map((p) => p.id)),
                    )
                  }
                  className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300"
                >
                  {selected.size === projects.length ? "取消" : "全选"}
                </button>
                <button
                  onClick={() => void deleteSelected()}
                  disabled={deleting || selected.size === 0}
                  className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  {deleting ? "…" : `删除${selected.size > 0 ? ` ${selected.size}` : ""}`}
                </button>
                <button
                  onClick={() => {
                    setSelecting(false);
                    setSelected(new Set());
                  }}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300"
                >
                  完成
                </button>
              </>
            ) : (
              <button
                onClick={() => setSelecting(true)}
                className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300"
              >
                选择
              </button>
            )}
          </div>
        </div>
        {/* 桌面版入口 */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/?device=desktop"
          className="mt-2 inline-block text-[11px] text-zinc-500 underline-offset-2 hover:underline"
        >
          切换到桌面版 →
        </a>
      </header>

      {/* 新建项目 */}
      <section className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5">
        <div className="flex items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createProject()}
            placeholder="输入项目标题…"
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2.5 text-sm outline-none placeholder:text-zinc-500 focus:border-violet-500"
          />
          <button
            onClick={() => void createProject()}
            disabled={creating || !title.trim()}
            className="shrink-0 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
          >
            {creating ? "…" : "新建"}
          </button>
        </div>
      </section>

      {error && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400">×</button>
        </div>
      )}

      {/* 项目列表（单列） */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 py-16 text-center">
          <p className="text-zinc-400">还没有项目</p>
          <p className="mt-1 text-xs text-zinc-600">在上方填写标题，创建你的第一部 AI 漫剧</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => {
            const checked = selected.has(p.id);
            const isExpanded = expanded.has(p.id);
            const isActing = acting === p.id;
            const exec = inferExecState(p);
            const steps = inferSteps(p);
            const totalSubs = steps.reduce((s, st) => s + st.subs.length, 0);
            const doneSubs = steps.reduce((s, st) => s + st.subs.filter((x) => x.status === "done").length, 0);
            const pct = totalSubs > 0 ? Math.round((doneSubs / totalSubs) * 100) : 0;

            return (
              <div
                key={p.id}
                className={`overflow-hidden rounded-xl border bg-zinc-900/60 transition ${
                  selecting ? (checked ? "border-violet-500 ring-2 ring-violet-500/40" : "border-zinc-700") : "border-zinc-800"
                }`}
              >
                {/* 卡片主体 */}
                <Link
                  href={selecting ? "#" : `/m/projects/${p.id}`}
                  onClick={(e) => {
                    if (!selecting) return;
                    e.preventDefault();
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    });
                  }}
                  className="block p-4"
                >
                  {/* 标题行 + 状态徽章 */}
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="line-clamp-2 flex-1 text-sm font-semibold leading-snug">{p.title}</h2>
                    {!selecting && (
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {exec === "FAILED" && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void projectAction(p.id, "retryFailed");
                            }}
                            disabled={isActing}
                            className="rounded-md bg-red-600/90 px-2 py-0.5 text-[10px] font-medium text-white"
                          >
                            {isActing ? "…" : "↻ 重试"}
                          </button>
                        )}
                        {exec === "PAUSED" && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void projectAction(p.id, "resumePaused");
                            }}
                            disabled={isActing}
                            className="rounded-md bg-amber-600/90 px-2 py-0.5 text-[10px] font-medium text-white"
                          >
                            {isActing ? "…" : "▶ 继续"}
                          </button>
                        )}
                        <span className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${EXEC_COLOR[exec]}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${EXEC_DOT[exec]}`} />
                          {EXEC_LABEL[exec]}
                        </span>
                      </div>
                    )}
                    {selecting && (
                      <span
                        aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] ${
                          checked ? "border-violet-500 bg-violet-600 text-white" : "border-zinc-600 text-transparent"
                        }`}
                      >
                        ✓
                      </span>
                    )}
                  </div>

                  {/* 4 步进度条 */}
                  <div className="mt-3 flex items-center gap-1">
                    {steps.map((s) => (
                      <div
                        key={s.key}
                        className={`h-1.5 flex-1 rounded-full ${
                          s.status === "done" ? "bg-emerald-500" : s.status === "active" ? "bg-violet-500" : "bg-zinc-800"
                        }`}
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500">
                    <span>
                      {doneSubs}/{totalSubs} · {pct}%
                    </span>
                    <span>
                      剧集 {p._count?.episodes ?? 0}/{p.episodeCount ?? 6}
                    </span>
                  </div>
                </Link>

                {/* 展开/收起 */}
                {!selecting && (
                  <>
                    <button
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        })
                      }
                      className="flex w-full items-center justify-between border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500"
                    >
                      <span>{isExpanded ? "收起步骤" : "查看 4 大步骤"}</span>
                      <span className={`transition ${isExpanded ? "rotate-180" : ""}`}>▾</span>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-3">
                        {steps.map((s) => (
                          <div key={s.key} className="mb-2.5 last:mb-0">
                            <Link
                              href={`/m/projects/${p.id}?step=${s.key}`}
                              className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-zinc-300"
                            >
                              <span
                                className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${
                                  s.status === "done"
                                    ? "bg-emerald-500 text-white"
                                    : s.status === "active"
                                      ? "bg-violet-500 text-white"
                                      : "bg-zinc-800 text-zinc-500"
                                }`}
                              >
                                {s.status === "done" ? "✓" : "·"}
                              </span>
                              <span className="tabular-nums">{s.num}</span>
                              <span>{s.name}</span>
                            </Link>
                            <ul className="ml-5 space-y-0.5">
                              {s.subs.map((sub) => (
                                <li key={sub.id}>
                                  <Link
                                    href={`/m/projects/${p.id}?step=${s.key}&sub=${sub.id}`}
                                    className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] text-zinc-400"
                                  >
                                    <span
                                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                        sub.status === "done" ? "bg-emerald-500" : sub.status === "active" ? "bg-violet-500" : "bg-zinc-700"
                                      }`}
                                    />
                                    <span className="flex-1 truncate">{sub.name}</span>
                                    {sub.progress && (
                                      <span className="shrink-0 text-[9px] text-zinc-500 tabular-nums">{sub.progress}</span>
                                    )}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {nextCursor && (
        <div className="mt-4 text-center">
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-300 disabled:opacity-40"
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </main>
  );
}
