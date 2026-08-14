"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ProjectCardSkeleton } from "@/components/shared/Skeleton";

interface Project {
  id: string;
  title: string;
  /** Prisma ProjectStatus */
  status: string;
  episodeCount: number;
  createdAt: string;
  updatedAt: string;
  novelText?: string | null;
  novelPath?: string | null;
  _count?: { scripts: number; characters: number; scenes: number; episodes: number };
  scripts?: { id: string; approved: boolean; version: number; status: string }[];
  characters?: { id: string; name: string; refImageIds: string[] }[];
  scenes?: { id: string; name: string; refImageIds: string[] }[];
  assets?: { id: string; type: string }[];
  episodes?: { id: string; number: number; status: string; finalPath: string | null }[];
  tasks?: { status: string; type: string }[];
}

// ========== 4 大步骤 × 子步骤（与详情页 SUB_STEPS 保持一致） ==========
// 每个子步骤可点击 → 跳转到详情页对应锚点（#id）展开具体操作

type SubStatus = "done" | "active" | "pending";

interface SubStep {
  id: string;
  name: string;
  status: SubStatus;
  /** 进度数字（如 6/6），无则 null */
  progress: string | null;
}

interface FlowStep {
  key: string;
  num: string;
  name: string;
  desc: string;
  status: SubStatus;
  subs: SubStep[];
}

const STEP_TARGET = 6; // 默认目标集数，与创建项目默认值一致

/** 根据项目实际数据推断 4 大步骤 × 各子步骤状态 */
function inferSteps(p: Project): FlowStep[] {
  const hasNovel = Boolean(p.novelText?.trim() || p.novelPath);
  const characters = p.characters ?? [];
  const scenes = p.scenes ?? [];
  const assets = p.assets ?? [];
  const episodes = p.episodes ?? [];
  const scripts = p.scripts ?? [];

  // 子步骤进度
  const charsWithImage = characters.filter((c) => c.refImageIds?.length > 0).length;
  const scenesWithImage = scenes.filter((s) => s.refImageIds?.length > 0).length;
  const propsWithImage = assets.length; // 道具数量即视为有设计
  const episodesComposed = episodes.filter((e) => e.finalPath).length;
  const totalEpisodes = episodes.length;

  // ---- 01 剧本工坊 ----
  const s1_1_done = hasNovel;
  const s1_2_done = characters.length > 0;
  const s1_3_done = episodes.length >= (p.episodeCount || STEP_TARGET) && episodes.length > 0;
  const s1_4_done = scripts.length > 0 && scripts.some((s) => s.approved);
  const s1_active = s1_1_done ? (s1_2_done ? (s1_3_done ? (s1_4_done ? "done" : "active") : "active") : "active") : "active";

  const s1: FlowStep = {
    key: "script",
    num: "01",
    name: "剧本工坊",
    desc: "上传小说 → 提炼人设 → 生成分集剧本",
    status: s1_active,
    subs: [
      { id: "script-upload", name: "上传小说", status: s1_1_done ? "done" : (hasNovel ? "active" : "pending"), progress: null },
      { id: "script-character", name: "提炼角色", status: s1_2_done ? "done" : (characters.length > 0 ? "active" : "pending"), progress: characters.length > 0 ? `${characters.length}` : null },
      { id: "script-outline", name: "分集大纲", status: s1_3_done ? "done" : (episodes.length > 0 ? "active" : "pending"), progress: episodes.length > 0 ? `${episodes.length}/${p.episodeCount || STEP_TARGET}` : null },
      { id: "script-scripts", name: "分集剧本", status: s1_4_done ? "done" : (scripts.length > 0 ? "active" : "pending"), progress: scripts.length > 0 ? `${scripts.length}` : null },
    ],
  };

  // ---- 02 资产工厂 ----
  // 子步骤：角色定妆照 / 场景空镜 / 道具设计
  const s2_chars_done = charsWithImage >= characters.length && characters.length > 0;
  const s2_scenes_done = scenesWithImage >= scenes.length && scenes.length > 0;
  const s2_props_done = propsWithImage > 0;
  const s2_complete = s2_chars_done && s2_scenes_done && s2_props_done;
  const s2_start = s1.subs.every((s) => s.status === "done");
  const s2_status: SubStatus = s2_complete ? "done" : s2_start ? "active" : "pending";

  const s2: FlowStep = {
    key: "asset",
    num: "02",
    name: "资产工厂",
    desc: "角色 / 场景 / 道具设计稿 + 一致性锁定",
    status: s2_status,
    subs: [
      { id: "asset-character", name: "角色定妆照", status: s2_chars_done ? "done" : (charsWithImage > 0 || characters.length > 0 ? "active" : "pending"), progress: characters.length > 0 ? `${charsWithImage}/${characters.length}` : null },
      { id: "asset-scene", name: "场景空镜", status: s2_scenes_done ? "done" : (scenesWithImage > 0 || scenes.length > 0 ? "active" : "pending"), progress: scenes.length > 0 ? `${scenesWithImage}/${scenes.length}` : null },
      { id: "asset-prop", name: "道具设计", status: s2_props_done ? "done" : "pending", progress: assets.length > 0 ? `${assets.length}` : null },
    ],
  };

  // ---- 03 分镜车间 ----
  const s3_start = s2.status === "done";
  const s3_active = totalEpisodes > 0;
  const s3_complete = totalEpisodes > 0 && episodesComposed >= totalEpisodes;
  const s3_status: SubStatus = s3_complete ? "done" : s3_start ? "active" : "pending";

  const s3: FlowStep = {
    key: "storyboard",
    num: "03",
    name: "分镜车间",
    desc: "AI 分镜 → 7 维提示词 → 批量出图",
    status: s3_status,
    subs: [
      { id: "storyboard-episode", name: "选择剧集", status: s3_active ? "done" : (s3_start ? "active" : "pending"), progress: totalEpisodes > 0 ? `${totalEpisodes}集` : null },
      { id: "storyboard-shots", name: "分镜 · 出图", status: s3_complete ? "done" : (s3_active ? "active" : "pending"), progress: s3_active ? `${episodesComposed}/${totalEpisodes}` : null },
    ],
  };

  // ---- 04 视频合成厂 ----
  const s4_start = s3.status === "done";
  const s4_status: SubStatus = s4_start && episodesComposed >= totalEpisodes && totalEpisodes > 0 ? "done" : s4_start ? "active" : "pending";

  const s4: FlowStep = {
    key: "compose",
    num: "04",
    name: "视频合成厂",
    desc: "微动态 / TTS 配音 / 音效 BGM / 合成导出",
    status: s4_status,
    subs: [
      { id: "compose-episode", name: "选择剧集", status: s4_start ? "done" : "pending", progress: null },
      { id: "compose-preview", name: "成片预览", status: episodesComposed > 0 ? "done" : (s4_start ? "active" : "pending"), progress: episodesComposed > 0 ? `${episodesComposed}/${totalEpisodes}` : null },
      { id: "compose-shots", name: "镜头 · 配音", status: s4_status === "done" ? "done" : (episodesComposed > 0 ? "active" : "pending"), progress: null },
    ],
  };

  return [s1, s2, s3, s4];
}

/** 顶层执行状态（基于未完成任务聚合） */
type ExecState = "IDLE" | "RUNNING" | "PAUSED" | "FAILED";

const EXEC_LABEL: Record<ExecState, string> = {
  IDLE: "空闲",
  RUNNING: "执行中",
  PAUSED: "暂停",
  FAILED: "失败",
};

const EXEC_COLOR: Record<ExecState, string> = {
  IDLE: "bg-zinc-700/40 text-zinc-400",
  RUNNING: "bg-emerald-500/15 text-emerald-300",
  PAUSED: "bg-amber-500/15 text-amber-300",
  FAILED: "bg-red-500/15 text-red-300",
};

const EXEC_DOT: Record<ExecState, string> = {
  IDLE: "bg-zinc-600",
  RUNNING: "bg-emerald-400 animate-pulse",
  PAUSED: "bg-amber-400",
  FAILED: "bg-red-400",
};

function inferExecState(p: Project): ExecState {
  const tasks = p.tasks ?? [];
  const hasFailed = tasks.some((t) => t.status === "FAILED");
  if (hasFailed) return "FAILED";
  const hasPaused = tasks.some((t) => t.status === "PAUSED");
  if (hasPaused) return "PAUSED";
  const hasActive = tasks.some((t) => t.status === "PROCESSING" || t.status === "QUEUED");
  if (hasActive) return "RUNNING";
  return "IDLE";
}

// ========== 页面组件 ==========

export default function HomePage() {
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
  /** 已展开子步骤面板的项目 id */
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
    const timer = setInterval(() => {
      void loadProjects();
    }, 3000);
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
    if (creating) return;
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
      router.push(`/projects/${p.id}`);
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
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI 漫剧工坊</h1>
          <p className="mt-1 text-sm text-zinc-400">
            小说 → 剧本 → 资产 → 分镜 → 视频，全流程 AI 创作流水线
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selecting ? (
            <>
              <button
                onClick={() =>
                  setSelected(
                    selected.size === projects.length
                      ? new Set()
                      : new Set(projects.map((p) => p.id))
                  )
                }
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500"
              >
                {selected.size === projects.length ? "取消全选" : "全选"}
              </button>
              <button
                onClick={() => void deleteSelected()}
                disabled={deleting || selected.size === 0}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? "删除中…" : `删除 ${selected.size} 项`}
              </button>
              <button
                onClick={() => {
                  setSelecting(false);
                  setSelected(new Set());
                }}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500"
              >
                完成
              </button>
            </>
          ) : (
            <>
              <Link href="/tasks" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500">
                任务中心
              </Link>
              <Link href="/settings" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500">
                设置
              </Link>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/?device=mobile"
                title="预览移动端界面"
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500"
              >
                移动端
              </a>
              <button
                onClick={() => setSelecting(true)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500"
              >
                选择
              </button>
            </>
          )}
        </div>
      </header>

      <section className="mb-8 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createProject()}
            placeholder="输入项目标题…"
            className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-950/60 px-4 py-2.5 text-sm outline-none transition placeholder:text-zinc-500 focus:border-violet-500"
          />
          <button
            onClick={() => void createProject()}
            disabled={creating || !title.trim()}
            className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? "创建中…" : "新建项目"}
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          创建后进入详情页，在「剧本工坊」中导入小说并定制集数。
        </p>
      </section>
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-red-800 bg-red-950/30 px-4 py-2 text-sm text-red-300">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400 hover:text-red-200">×</button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <ProjectCardSkeleton key={i} />)}
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-700 py-20 text-center">
          <p className="text-zinc-400">还没有项目</p>
          <p className="mt-1 text-sm text-zinc-600">在上方填写标题，创建你的第一部 AI 漫剧</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
          {projects.map((p) => {
            const checked = selected.has(p.id);
            const isExpanded = expanded.has(p.id);
            const isActing = acting === p.id;
            const exec = inferExecState(p);
            const steps = inferSteps(p);

            // 已完成的所有子步骤总数 / 总子步骤数（用于顶部细进度条）
            const totalSubs = steps.reduce((s, st) => s + st.subs.length, 0);
            const doneSubs = steps.reduce((s, st) => s + st.subs.filter((x) => x.status === "done").length, 0);
            const pct = totalSubs > 0 ? Math.round((doneSubs / totalSubs) * 100) : 0;

            return (
              <div
                key={p.id}
                className={`group relative flex h-full flex-col overflow-hidden rounded-xl border bg-zinc-900/60 transition ${
                  selecting
                    ? checked
                      ? "border-violet-500 ring-2 ring-violet-500/40"
                      : "border-zinc-700"
                    : "border-zinc-800 hover:border-violet-500/60"
                }`}
              >
                {/* 右上角操作区：选择框 / 失败-暂停按钮 / 状态徽章 */}
                {!selecting && (
                  <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
                    {exec === "FAILED" && (
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void projectAction(p.id, "retryFailed");
                        }}
                        disabled={isActing}
                        title="仅重试该项目失败的任务，已完成的部分不会重跑"
                        className="flex items-center gap-1 rounded-md bg-red-600/90 px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span>↻</span>
                        {isActing ? "处理中" : "重试"}
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
                        title="继续执行该项目中之前被暂停的任务"
                        className="flex items-center gap-1 rounded-md bg-amber-600/90 px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span>▶</span>
                        {isActing ? "处理中" : "继续"}
                      </button>
                    )}
                    <span
                      className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${EXEC_COLOR[exec]}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${EXEC_DOT[exec]}`} />
                      {EXEC_LABEL[exec]}
                    </span>
                  </div>
                )}

                {/* 主体可点击区（标题 + 进度） */}
                <Link
                  href={selecting ? "#" : `/projects/${p.id}`}
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
                  aria-pressed={selecting ? checked : undefined}
                  className="flex flex-1 flex-col p-5"
                >
                  {/* 标题预留右侧空间给徽章/按钮 */}
                  <div className="flex items-start gap-2 pr-32">
                    <h2 className="line-clamp-2 flex-1 font-semibold text-zinc-100">{p.title}</h2>
                  </div>
                  {/* 选择模式下的选择框 */}
                  {selecting && (
                    <span
                      aria-hidden
                      className={`absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded border text-[11px] ${
                        checked ? "border-violet-500 bg-violet-600 text-white" : "border-zinc-600 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                  )}

                  {/* 4 步进度条 */}
                  <div className="mt-4 flex items-center gap-1.5">
                    {steps.map((s) => (
                      <div
                        key={s.key}
                        title={`${s.num} ${s.name} · ${
                          s.status === "done" ? "已完成" : s.status === "active" ? "进行中" : "未开始"
                        }`}
                        className={`h-1.5 flex-1 rounded-full ${
                          s.status === "done"
                            ? "bg-emerald-500"
                            : s.status === "active"
                              ? "bg-violet-500"
                              : "bg-zinc-800"
                        }`}
                      />
                    ))}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
                    <span>
                      {doneSubs}/{totalSubs} 子步骤 · {pct}%
                    </span>
                    <span>
                      剧集 {p._count?.episodes ?? 0}/{p.episodeCount ?? 6}
                    </span>
                  </div>
                </Link>

                {/* 展开/收起按钮 */}
                {!selecting && (
                  <button
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                    className="flex shrink-0 items-center justify-between border-t border-zinc-800 px-5 py-2 text-xs text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-300"
                  >
                    <span>{isExpanded ? "收起 4 大步骤" : "查看 4 大步骤"}</span>
                    <span className={`transition ${isExpanded ? "rotate-180" : ""}`}>▾</span>
                  </button>
                )}

                {/* 展开面板（与其他卡片同高对齐） */}
                {!selecting && isExpanded && (
                  <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/40 p-4">
                    {steps.map((s) => (
                      <div key={s.key} className="mb-3 last:mb-0">
                        <Link
                          href={`/projects/${p.id}?step=${s.key}`}
                          className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-300 transition hover:text-violet-300"
                        >
                          <span
                            className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
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
                          <span className="ml-auto text-[11px] text-zinc-600">
                            {s.status === "done" ? "已完成" : s.status === "active" ? "进行中" : "未开始"}
                          </span>
                        </Link>
                        <ul className="ml-6 space-y-0.5">
                          {s.subs.map((sub) => (
                            <li key={sub.id}>
                              <Link
                                href={`/projects/${p.id}?step=${s.key}&sub=${sub.id}`}
                                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
                              >
                                <span
                                  className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-full text-[8px] ${
                                    sub.status === "done"
                                      ? "bg-emerald-500 text-white"
                                      : sub.status === "active"
                                        ? "bg-violet-500 text-white"
                                        : "bg-zinc-800 text-zinc-600"
                                  }`}
                                >
                                  {sub.status === "done" ? "✓" : ""}
                                </span>
                                <span className="flex-1 truncate">{sub.name}</span>
                                {sub.progress && (
                                  <span className="shrink-0 text-[10px] text-zinc-500 tabular-nums">{sub.progress}</span>
                                )}
                                <span className="text-zinc-600">→</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    <div className="mt-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
                      点击任一子步骤 → 跳转详情页对应模块
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {nextCursor && (
        <div className="mt-6 text-center">
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-zinc-700 px-5 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-40"
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </main>
  );
}