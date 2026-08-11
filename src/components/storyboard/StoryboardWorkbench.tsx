"use client";

/**
 * 分镜车间工作台（M3）
 * ① 选集 → 分镜（场景→镜头切分 + 7 维提示词）
 * ② 批量出图（引用锁定角色定妆照/场景空镜）→ 缩略图审阅
 * 运行中任务 2s 轮询。
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ========== 类型 ==========

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

const SHOT_SIZE_LABEL: Record<string, string> = {
  特写: "特写",
  近景: "近景",
  中景: "中景",
  全景: "全景",
  远景: "远景",
};

const imgUrl = (p: string) => `/api/files?path=${encodeURIComponent(p)}`;

const STATUS_BADGE: Record<string, { text: string; cls: string }> = {
  PROMPT_READY: { text: "提示词就绪", cls: "bg-sky-950 text-sky-300" },
  IMAGE_GENERATING: { text: "出图中", cls: "bg-violet-950 text-violet-300" },
  IMAGE_DONE: { text: "已出图", cls: "bg-emerald-950 text-emerald-300" },
  IMAGE_FAILED: { text: "失败", cls: "bg-red-950 text-red-300" },
  REJECTED: { text: "已否决", cls: "bg-amber-950 text-amber-300" },
  PENDING: { text: "待分镜", cls: "bg-zinc-800 text-zinc-400" },
};

// ========== 组件 ==========

export default function StoryboardWorkbench({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  }, [projectId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // 运行中任务轮询
  useEffect(() => {
    if (!data?.runningTask) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        void load();
      }
      return;
    }
    if (!pollRef.current) {
      pollRef.current = setInterval(() => void load(), 2000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [data?.runningTask, load]);

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
          // 409 并发保护：不算错误，刷新后由 runningTask 轮询接管展示进度
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
    [projectId, load]
  );

  const patchShot = useCallback(
    async (shotId: string, status: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/storyboard`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shotId, status }),
        });
        if (!res.ok) throw new Error("操作失败");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作失败");
      } finally {
        setBusy(false);
      }
    },
    [projectId, load]
  );

  // 手动分镜：添加镜头（P1-4）
  const [manual, setManual] = useState({ sceneName: "", action: "", dialog: "", dialogChar: "", duration: "5" });
  const addManualShots = useCallback(async () => {
    if (!selected) return;
    if (!manual.action.trim() && !manual.dialog.trim()) {
      setError("请至少填写动作或台词");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "manual",
          episodeNumber: selected,
          shots: [{
            sceneName: manual.sceneName.trim() || undefined,
            action: manual.action.trim() || undefined,
            dialog: manual.dialog.trim() || undefined,
            dialogChar: manual.dialogChar.trim() || undefined,
            duration: Number(manual.duration) || 5,
          }],
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "添加失败");
      setManual({ sceneName: "", action: "", dialog: "", dialogChar: "", duration: "5" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }, [projectId, selected, manual, load]);

  // 删除镜头（P1-4）
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
    [projectId, load]
  );

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-sm text-zinc-500">加载中…</div>;
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-sm text-zinc-500">
        {error ?? "加载失败"} · <button className="text-violet-400 hover:underline" onClick={() => void load()}>重试</button>
      </div>
    );
  }

  const task = data.runningTask;
  const ep = data.episodes.find((e) => e.number === selected) ?? null;
  const shots = ep?.shots ?? [];
  const doneCount = shots.filter((s) => s.imagePath).length;
  const genDisabled = busy || !!task;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {/* 运行中任务提示 */}
      {task && (
        <div className="flex items-center gap-3 rounded-xl border border-violet-800 bg-violet-950/30 px-4 py-3 text-sm text-violet-200">
          <span className="h-3 w-3 animate-pulse rounded-full bg-violet-400" />
          <span className="flex-1">{task.label}</span>
          <span className="text-xs text-violet-400">{task.status === "PROCESSING" ? "运行中" : "排队中"}</span>
        </div>
      )}

      {/* 选集 */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">① 选择剧集</h3>
            <p className="mt-0.5 text-xs text-zinc-500">对单集执行分镜与出图（剧本工坊完成后可用）。</p>
          </div>
        </div>
        {data.episodes.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">暂无剧集，请先在剧本工坊生成分集剧本。</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {data.episodes.map((e) => {
              const d = e.shots.filter((s) => s.imagePath).length;
              return (
                <button
                  key={e.number}
                  onClick={() => setSelected(e.number)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                    selected === e.number
                      ? "border-violet-500 bg-violet-950/40 text-violet-200"
                      : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  第{e.number}集{e.title ? ` · ${e.title}` : ""}
                  {e.shots.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-zinc-500">
                      {d}/{e.shots.length}图
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {ep && (
        <>
          {/* 手动分镜（P1-4） */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">手动分镜</h3>
                <p className="mt-0.5 text-xs text-zinc-500">不依赖 AI，手动添加镜头（场景 / 动作 / 台词），添加后自动组装提示词并锁定资产参考图。</p>
              </div>
              <button
                onClick={() => void addManualShots()}
                disabled={busy}
                className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
              >
                添加镜头
              </button>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-5">
              <input
                value={manual.sceneName}
                onChange={(e) => setManual((m) => ({ ...m, sceneName: e.target.value }))}
                placeholder="场景名（如：茶水间）"
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 focus:border-violet-600 focus:outline-none"
              />
              <input
                value={manual.action}
                onChange={(e) => setManual((m) => ({ ...m, action: e.target.value }))}
                placeholder="画面动作（必填或填台词）"
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 focus:border-violet-600 focus:outline-none md:col-span-2"
              />
              <input
                value={manual.dialog}
                onChange={(e) => setManual((m) => ({ ...m, dialog: e.target.value }))}
                placeholder="台词（可选）"
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 focus:border-violet-600 focus:outline-none md:col-span-1"
              />
              <input
                value={manual.dialogChar}
                onChange={(e) => setManual((m) => ({ ...m, dialogChar: e.target.value }))}
                placeholder="角色名（可选）"
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 focus:border-violet-600 focus:outline-none"
              />
              <input
                value={manual.duration}
                onChange={(e) => setManual((m) => ({ ...m, duration: e.target.value }))}
                placeholder="时长s"
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 focus:border-violet-600 focus:outline-none"
              />
            </div>
          </section>

          {/* 操作条 */}
          <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
            <button
              onClick={() => void post("storyboard", ep.number)}
              disabled={genDisabled || shots.length > 0}
              className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {shots.length > 0 ? "已分镜" : "AI 分镜"}
            </button>
            <button
              onClick={() => void post("images", ep.number)}
              disabled={genDisabled || shots.length === 0 || doneCount === shots.length}
              className="rounded-lg border border-violet-600 px-4 py-1.5 text-sm font-medium text-violet-300 transition hover:bg-violet-950/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              批量出图（{doneCount}/{shots.length}）
            </button>
            {shots.length > 0 && (
              <span className="text-xs text-zinc-500">
                {shots.length} 镜头 · 提示词引用已锁定资产参考图
              </span>
            )}
          </section>

          {/* 镜头网格 */}
          {shots.length > 0 && (
            <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shots.map((s) => {
                const badge = STATUS_BADGE[s.status] ?? { text: s.status, cls: "bg-zinc-800 text-zinc-400" };
                return (
                  <div key={s.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
                    <div className="flex h-36 items-center justify-center bg-zinc-900/80">
                      {s.imagePath ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imgUrl(s.imagePath)} alt={`镜头${s.sequence}`} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-xs text-zinc-600">
                          {s.status === "IMAGE_GENERATING" ? "生成中…" : s.status === "REJECTED" ? "已否决" : "未出图"}
                        </span>
                      )}
                    </div>
                    <div className="p-3">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-300">#{s.sequence}</span>
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                          {SHOT_SIZE_LABEL[s.camera.shotSize] ?? s.camera.shotSize}·{s.camera.angle}·{s.camera.movement}
                        </span>
                        <span className={`rounded px-1.5 py-0.5 ${badge.cls}`}>{badge.text}</span>
                        <span className="ml-auto text-zinc-600">{s.duration}s</span>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs text-zinc-300">{s.action}</p>
                      {s.dialog && (
                        <p className="mt-1 line-clamp-2 text-xs">
                          <span className="font-medium text-amber-300/90">{s.dialogChar}</span>
                          <span className="ml-1 text-zinc-400">「{s.dialog}」</span>
                        </p>
                      )}
                      {s.error && <p className="mt-1 text-[10px] text-red-400">{s.error.slice(0, 80)}</p>}
                      <div className="mt-2 flex items-center gap-1.5">
                        {s.refImages.length > 0 && (
                          <span className="text-[10px] text-zinc-600">{s.refImages.length} 参考图</span>
                        )}
                        <div className="ml-auto flex gap-1">
                          {(s.status === "IMAGE_FAILED" || s.status === "REJECTED" || (s.status === "PROMPT_READY")) && (
                            <button
                              onClick={() => void post("images", ep.number, s.id)}
                              disabled={genDisabled}
                              className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
                            >
                              出图
                            </button>
                          )}
                          {s.status === "IMAGE_DONE" && (
                            <>
                              <button
                                onClick={() => void patchShot(s.id, "REJECTED")}
                                disabled={busy}
                                className="rounded-md border border-amber-700/60 px-2 py-1 text-[11px] text-amber-300 transition hover:bg-amber-950/40 disabled:opacity-40"
                              >
                                否决
                              </button>
                              <button
                                onClick={() => void post("images", ep.number, s.id)}
                                disabled={genDisabled}
                                className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500 disabled:opacity-40"
                              >
                                重出
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => void deleteShot(s.id)}
                            disabled={busy}
                            title="删除镜头"
                            className="rounded-md border border-red-900/60 px-2 py-1 text-[11px] text-red-400/80 transition hover:bg-red-950/40 disabled:opacity-40"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* 提示词预览 */}
          {shots.length > 0 && (
            <details className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <summary className="cursor-pointer text-sm font-medium text-zinc-300">查看 7 维提示词（镜头 #{shots[0]?.sequence}）</summary>
              {shots[0]?.finalPrompt && (
                <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-950/70 p-3 text-[11px] leading-relaxed text-zinc-400">
                  {shots[0].finalPrompt}
                </pre>
              )}
            </details>
          )}
        </>
      )}

      <p className="text-center text-xs text-zinc-600">
        当前项目：{projectTitle} · 出图引用已锁定的角色定妆照与场景空镜，保证跨镜头一致性
      </p>
    </div>
  );
}
