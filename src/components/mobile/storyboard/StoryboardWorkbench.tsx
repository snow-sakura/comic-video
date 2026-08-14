"use client";

/**
 * 移动端 · 分镜车间工作台
 * ① 选集 → AI 分镜（场景→镜头切分） ② 批量出图 → 缩略图审阅
 * 复用 web 端相同 API（/storyboard、/shots），UI 针对移动端单列触控优化。
 */
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/lib/hooks/use-polling";
import { useAutoError } from "@/lib/hooks/use-auto-error";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";

interface Shot {
  id: string;
  sequence: number;
  sceneName: string | null;
  camera: { angle: string; movement: string; shotSize: string };
  action: string | null;
  dialog: string | null;
  dialogChar: string | null;
  dialogEmotion: string | null;
  duration: number;
  finalPrompt: string | null;
  imagePath: string | null;
  status: string;
  error: string | null;
  refImages: string[];
}

interface EpisodeData {
  id: string;
  number: number;
  title: string | null;
  status: string;
  shots: Shot[];
}

interface RunningTask {
  id: string;
  label: string;
  status: string;
  error: string | null;
}

interface WorkbenchData {
  episodes: EpisodeData[];
  runningTask: RunningTask | null;
}

const imgUrl = (p: string) => `/api/files?path=${encodeURIComponent(p)}`;

const STATUS_BADGE: Record<string, { text: string; cls: string }> = {
  PROMPT_READY: { text: "提示词就绪", cls: "bg-sky-950 text-sky-300" },
  IMAGE_GENERATING: { text: "出图中", cls: "bg-violet-950 text-violet-300" },
  IMAGE_DONE: { text: "已出图", cls: "bg-emerald-950 text-emerald-300" },
  IMAGE_FAILED: { text: "失败", cls: "bg-red-950 text-red-300" },
  REJECTED: { text: "已否决", cls: "bg-amber-950 text-amber-300" },
  PENDING: { text: "待分镜", cls: "bg-zinc-800 text-zinc-400" },
};

export default function StoryboardWorkbench({
  projectId,
  sub,
}: {
  projectId: string;
  projectTitle: string;
  sub?: string;
}) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useAutoError();
  const [busy, setBusy] = useState(false);
  const [expandedShot, setExpandedShot] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/storyboard`);
      if (!res.ok) throw new Error("加载失败");
      const d: WorkbenchData = await res.json();
      setData(d);
      if (d.episodes.length > 0) {
        setSelected((prev) => {
          if (prev && d.episodes.some((e) => e.number === prev)) return prev;
          return d.episodes[0].number;
        });
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, setError]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  usePolling(load, Boolean(data?.runningTask));

  const post = useCallback(
    async (stage: string, episodeNumber: number, shotId?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, episodeNumber, shotId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 409) {
            await load();
            return;
          }
          throw new Error(body.error ?? "触发失败");
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "触发失败");
      } finally {
        setBusy(false);
      }
    },
    [projectId, load, setError],
  );

  const patchShot = useCallback(
    async (shotId: string, status: string) => {
      setBusy(true);
      setError(null);
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          episodes: prev.episodes.map((ep) => ({
            ...ep,
            shots: ep.shots.map((s) => (s.id === shotId ? { ...s, status } : s)),
          })),
        };
      });
      try {
        const res = await fetch(`/api/projects/${projectId}/storyboard`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shotId, status }),
        });
        if (!res.ok) throw new Error("操作失败");
        await load();
      } catch (e) {
        await load();
        setError(e instanceof Error ? e.message : "操作失败");
      } finally {
        setBusy(false);
      }
    },
    [projectId, load, setError],
  );

  const deleteShot = useCallback(
    async (shotId: string) => {
      if (!window.confirm("删除该镜头？其分镜图/视频/配音将被一并清理。")) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, { method: "DELETE" });
        if (!res.ok) throw new Error("删除失败");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "删除失败");
      } finally {
        setBusy(false);
      }
    },
    [projectId, load, setError],
  );

  if (loading) return <WorkbenchSkeleton />;

  const show = (id: string) => !sub || sub === id;
  const rt = data?.runningTask;
  const running = rt && (rt.status === "QUEUED" || rt.status === "PROCESSING");
  const currentEp = data?.episodes.find((e) => e.number === selected) ?? null;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</div>
      )}
      {running && rt && (
        <div className="rounded-lg border border-violet-700 bg-violet-950/30 px-3 py-2 text-xs text-violet-200">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" /> {rt.label}（{rt.status === "QUEUED" ? "排队中" : "处理中"}）
        </div>
      )}

      {/* 选集 + 分镜 */}
      {show("storyboard-episode") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold">选择剧集</h3>
          {data && data.episodes.length > 0 ? (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {data.episodes.map((ep) => (
                  <button
                    key={ep.id}
                    onClick={() => setSelected(ep.number)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      selected === ep.number
                        ? "border-violet-600 bg-violet-600 text-white"
                        : "border-zinc-700 bg-zinc-900/40 text-zinc-400"
                    }`}
                  >
                    第{ep.number}集
                  </button>
                ))}
              </div>
              {currentEp && (
                <div className="mb-3 rounded-lg bg-zinc-950/40 p-2.5 text-[11px] text-zinc-400">
                  <p>标题：{currentEp.title || "未命名"}</p>
                  <p>镜头数：{currentEp.shots.length}</p>
                  <p>已出图：{currentEp.shots.filter((s) => s.status === "IMAGE_DONE").length}/{currentEp.shots.length}</p>
                </div>
              )}
              <button
                onClick={() => selected && void post("storyboard", selected)}
                disabled={busy || !selected}
                className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? "处理中…" : currentEp && currentEp.shots.length > 0 ? "重新分镜" : "AI 分镜"}
              </button>
            </>
          ) : (
            <p className="text-xs text-zinc-500">请先在剧本工坊生成分集剧本</p>
          )}
        </section>
      )}

      {/* 分镜·出图 */}
      {show("storyboard-shots") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">镜头列表</h3>
            {currentEp && currentEp.shots.length > 0 && (
              <button
                onClick={() => selected && void post("image", selected)}
                disabled={busy || !selected}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                {busy ? "…" : "批量出图"}
              </button>
            )}
          </div>
          {currentEp && currentEp.shots.length > 0 ? (
            <ul className="space-y-2">
              {currentEp.shots.map((s) => {
                const badge = STATUS_BADGE[s.status] ?? { text: s.status, cls: "bg-zinc-800 text-zinc-400" };
                const isOpen = expandedShot === s.id;
                return (
                  <li key={s.id} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/40">
                    <div className="flex gap-2.5 p-2.5">
                      {s.imagePath ? (
                        <img src={imgUrl(s.imagePath)} alt={`镜头${s.sequence}`} className="h-16 w-16 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] text-zinc-600">
                          {s.status === "IMAGE_GENERATING" ? "…" : "无图"}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium">镜头 {s.sequence}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                        </div>
                        {s.sceneName && <p className="mt-0.5 text-[11px] text-zinc-500 truncate">{s.sceneName}</p>}
                        {s.action && <p className="text-[11px] text-zinc-400 line-clamp-2">{s.action}</p>}
                        {s.dialog && (
                          <p className="mt-0.5 text-[11px] text-zinc-500 line-clamp-1">
                            {s.dialogChar ? `${s.dialogChar}：` : ""}
                            {s.dialog}
                          </p>
                        )}
                      </div>
                    </div>
                    {/* 操作按钮 */}
                    <div className="flex flex-wrap gap-1.5 border-t border-zinc-800 px-2.5 py-1.5">
                      <button
                        onClick={() => void post("regenerate", selected!, s.id)}
                        disabled={busy}
                        className="rounded bg-violet-600 px-2 py-0.5 text-[10px] text-white disabled:opacity-40"
                      >
                        重出图
                      </button>
                      {s.status === "IMAGE_DONE" && (
                        <button
                          onClick={() => void patchShot(s.id, "REJECTED")}
                          disabled={busy}
                          className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 disabled:opacity-40"
                        >
                          否决
                        </button>
                      )}
                      {s.status === "REJECTED" && (
                        <button
                          onClick={() => void patchShot(s.id, "IMAGE_DONE")}
                          disabled={busy}
                          className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 disabled:opacity-40"
                        >
                          恢复
                        </button>
                      )}
                      <button
                        onClick={() => setExpandedShot(isOpen ? null : s.id)}
                        className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300"
                      >
                        {isOpen ? "收起" : "详情"}
                      </button>
                      <button
                        onClick={() => void deleteShot(s.id)}
                        disabled={busy}
                        className="ml-auto rounded border border-red-800 px-2 py-0.5 text-[10px] text-red-300 disabled:opacity-40"
                      >
                        删除
                      </button>
                    </div>
                    {/* 展开详情 */}
                    {isOpen && (
                      <div className="border-t border-zinc-800 bg-zinc-900/60 px-2.5 py-2 text-[11px] text-zinc-400">
                        {s.camera && (
                          <p>镜头：{s.camera.shotSize} / {s.camera.angle} / {s.camera.movement}</p>
                        )}
                        <p>时长：{s.duration}s</p>
                        {s.finalPrompt && (
                          <p className="mt-1 text-zinc-500">提示词：{s.finalPrompt.slice(0, 120)}…</p>
                        )}
                        {s.error && <p className="mt-1 text-red-400">错误：{s.error}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">{currentEp ? "该集暂无镜头，请先 AI 分镜" : "请先选择剧集"}</p>
          )}
        </section>
      )}
    </div>
  );
}
