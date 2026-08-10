"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Project {
  id: string;
  title: string;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  _count?: { scripts: number; characters: number; scenes: number; episodes: number };
}

const STATUS_LABEL: Record<Project["status"], string> = {
  DRAFT: "草稿",
  ACTIVE: "制作中",
  COMPLETED: "已完成",
  ARCHIVED: "已归档",
};

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  async function loadProjects() {
    setLoading(true);
    try {
      const res = await fetch("/api/projects");
      if (res.ok) setProjects(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  async function createProject() {
    if (!title.trim()) return;
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
      setTitle("");
      setProjects((prev) => [p, ...prev]);
    } catch {
      setError("网络错误");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI 漫剧工坊</h1>
          <p className="mt-1 text-sm text-zinc-400">
            小说 → 剧本 → 资产 → 分镜 → 视频，全流程 AI 创作流水线
          </p>
        </div>
        <Link
          href="/settings"
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500"
        >
          设置
        </Link>
      </header>

      {/* 新建项目 */}
      <div className="mb-8 flex gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void createProject()}
          placeholder="输入新项目标题…"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm outline-none transition placeholder:text-zinc-500 focus:border-zinc-500"
        />
        <button
          onClick={() => void createProject()}
          disabled={creating || !title.trim()}
          className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {creating ? "创建中…" : "新建项目"}
        </button>
      </div>
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      {/* 项目列表 */}
      {loading ? (
        <p className="py-16 text-center text-sm text-zinc-500">加载中…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-700 py-20 text-center">
          <p className="text-zinc-400">还没有项目</p>
          <p className="mt-1 text-sm text-zinc-600">在上方输入标题，创建你的第一部 AI 漫剧</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 transition hover:border-zinc-600 hover:bg-zinc-900"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="line-clamp-2 font-semibold text-zinc-100 group-hover:text-white">
                  {p.title}
                </h2>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                    p.status === "ACTIVE"
                      ? "bg-violet-500/15 text-violet-300"
                      : p.status === "COMPLETED"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-zinc-700/40 text-zinc-400"
                  }`}
                >
                  {STATUS_LABEL[p.status]}
                </span>
              </div>
              <div className="mt-4 flex gap-4 text-xs text-zinc-500">
                <span>剧本 {p._count?.scripts ?? 0}</span>
                <span>角色 {p._count?.characters ?? 0}</span>
                <span>场景 {p._count?.scenes ?? 0}</span>
                <span>集数 {p._count?.episodes ?? 0}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
