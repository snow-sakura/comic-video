"use client";

/**
 * 视频合成厂工作台（M4）
 * ① 选集 → ② 生成视频（分镜图 → 可灵微动态）→ ③ 配音（TTS）→ ④ 合成导出（ffmpeg + 可选 BGM）
 * 运行中任务 2s 轮询。
 */
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/lib/hooks/use-polling";
import { useAutoError } from "@/lib/hooks/use-auto-error";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";

// ========== 类型 ==========

interface Shot {
  id: string;
  sequence: number;
  sceneName: string | null;
  action: string | null;
  dialog: string | null;
  dialogChar: string | null;
  duration: number;
  imagePath: string | null;
  videoPath: string | null;
  voicePath: string | null;
  subtitlePath: string | null;
  status: string;
  error: string | null;
}

interface EpisodeData {
  id: string;
  number: number;
  title: string | null;
  status: string;
  finalPath: string | null;
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
  IMAGE_DONE: { text: "待生成视频", cls: "bg-sky-950 text-sky-300" },
  VIDEO_GENERATING: { text: "视频生成中", cls: "bg-violet-950 text-violet-300" },
  VIDEO_DONE: { text: "视频就绪", cls: "bg-emerald-950 text-emerald-300" },
  VIDEO_FAILED: { text: "视频失败", cls: "bg-red-950 text-red-300" },
  VOICE_GENERATING: { text: "配音中", cls: "bg-fuchsia-950 text-fuchsia-300" },
  VOICE_DONE: { text: "配音完成", cls: "bg-teal-950 text-teal-300" },
  VOICE_FAILED: { text: "配音失败", cls: "bg-red-950 text-red-300" },
  REJECTED: { text: "已否决", cls: "bg-amber-950 text-amber-300" },
  PENDING: { text: "待分镜", cls: "bg-zinc-800 text-zinc-400" },
  PROMPT_READY: { text: "待出图", cls: "bg-zinc-800 text-zinc-400" },
  IMAGE_GENERATING: { text: "出图中", cls: "bg-zinc-800 text-zinc-400" },
  IMAGE_FAILED: { text: "失败", cls: "bg-red-950 text-red-300" },
};

const BGM_MOODS = ["romance", "tension", "warmth", "sadness", "excitement", "mystery", "calm", "epic", "humor", "horror"];

/** 成片墙：展示全部已成片剧集（小窗口），点击放大播放（模态） */
function FinishedWall({
  episodes,
  currentNumber,
  projectId,
}: {
  episodes: EpisodeData[];
  currentNumber: number | null;
  projectId: string;
}) {
  const finished = episodes.filter((e) => e.finalPath);
  const [viewer, setViewer] = useState<EpisodeData | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Esc 关闭放大窗口
  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  return (
    <section id="compose-preview" className="scroll-mt-24 rounded-2xl border border-emerald-800 bg-emerald-950/20 p-4">
      {finished.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="text-sm font-medium text-zinc-400">暂无成片</p>
          <p className="max-w-md text-xs text-zinc-600">
            请先在「镜头·配音」小步骤完成视频与配音，再点击「合成导出」生成成片。
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="font-semibold text-emerald-200">成片预览 · 全部已成片（{finished.length}/{episodes.length}）</h3>
            <span className="text-xs text-zinc-500">点击小窗放大播放</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {finished.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setViewer(e)}
                className={`group relative overflow-hidden rounded-xl border bg-black text-left transition hover:border-emerald-400/70 hover:shadow-lg hover:shadow-emerald-500/10 ${
                  currentNumber === e.number
                    ? "border-emerald-500 ring-2 ring-emerald-500/40"
                    : "border-zinc-700"
                }`}
                aria-label={`播放第${e.number}集成片`}
              >
                <video
                  src={imgUrl(e.finalPath!)}
                  preload="metadata"
                  muted
                  playsInline
                  className="aspect-video w-full object-cover"
                />
                <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/90 to-transparent px-3 pb-2 pt-6">
                  <span className="text-sm font-medium text-white">第{e.number}集</span>
                  <span className="text-xs text-emerald-300">{e.title || "—"}</span>
                </span>
                <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white opacity-0 transition group-hover:opacity-100">
                  ▶ 放大播放
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* 放大播放模态 */}
      {viewer?.finalPath && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={() => setViewer(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`第${viewer.number}集成片播放`}
        >
          <div
            className="w-full max-w-4xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <span className="text-sm font-semibold text-zinc-100">
                第{viewer.number}集 · {viewer.title || "成片预览"}
              </span>
              <button
                type="button"
                onClick={() => setViewer(null)}
                className="rounded-lg px-2.5 py-1 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                aria-label="关闭"
              >
                ✕ 关闭（Esc）
              </button>
            </div>
            <video
              key={viewer.id}
              controls
              autoPlay
              preload="metadata"
              crossOrigin="anonymous"
              className="aspect-video w-full bg-black"
              src={imgUrl(viewer.finalPath)}
            >
              <track
                kind="subtitles"
                srcLang="zh"
                label="中文字幕"
                default
                src={imgUrl(viewer.finalPath.replace(/\.mp4$/, ".vtt"))}
              />
            </video>
            <div className="flex flex-wrap gap-2 border-t border-zinc-800 p-3">
              <a
                href={imgUrl(viewer.finalPath)}
                download
                className="whitespace-nowrap inline-block rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500"
              >
                下载成片
              </a>
              <a
                href={imgUrl(viewer.finalPath.replace(/\.mp4$/, ".srt"))}
                download
                className="whitespace-nowrap inline-block rounded-lg bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-100 transition hover:bg-zinc-600"
              >
                下载 SRT 字幕
              </a>
              <a
                href={`/api/projects/${projectId}/export?episode=${viewer.number}`}
                download
                className="whitespace-nowrap inline-block rounded-lg bg-teal-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-teal-500"
              >
                导出全部资源（ZIP）
              </a>
              <button
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}/api/projects/${projectId}/export?episode=${viewer.number}`;
                  void navigator.clipboard
                    .writeText(url)
                    .then(() => {
                      setToast("分享链接已复制");
                    })
                    .catch(() => setToast("复制失败，请手动复制地址栏链接"));
                }}
                className="whitespace-nowrap inline-block rounded-lg border border-zinc-600 px-4 py-1.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800"
              >
                复制分享链接
              </button>
              {toast && <span className="self-center text-xs text-teal-300">{toast}</span>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ========== 组件 ==========

export default function ComposeWorkbench({
  projectId,
  projectTitle,
  sub,
}: {
  projectId: string;
  projectTitle: string;
  /** 详情页三栏模式：指定小步骤 id 时只渲染对应 section（默认全展示） */
  sub?: string;
}) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useAutoError();
  const [busy, setBusy] = useState(false);
  const [bgmMood, setBgmMood] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/compose`);
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

  // 智能轮询：仅 runningTask 存在时启动，指数退避
  usePolling(load, Boolean(data?.runningTask));

  const post = useCallback(
    async (stage: string, episodeNumber: number, shotId?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/compose`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, episodeNumber, shotId, bgmMood }),
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
    [projectId, load, bgmMood]
  );

  // 保存台词（P1-3 对白替换）：PATCH 后由 API 自动作废旧配音产物
  const saveDialog = useCallback(
    async (shotId: string) => {
      setSaving(shotId);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dialog: draft[shotId] ?? "" }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "保存失败");
        await load();
        setDraft((d) => {
          const next = { ...d };
          delete next[shotId];
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "保存失败");
      } finally {
        setSaving(null);
      }
    },
    [projectId, draft, load]
  );

  if (loading) {
    return <WorkbenchSkeleton />;
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
  // 按产物路径统计（不依赖状态枚举，避免后续状态覆盖导致计数失真）
  const videoDone = shots.filter((s) => s.videoPath).length;
  const voiceDone = shots.filter((s) => s.voicePath).length;
  const voicedShots = shots.filter((s) => s.dialog).length;
  const hasVideo = shots.some((s) => s.videoPath);
  const genDisabled = busy || !!task;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {/* 运行中任务提示 + 进度条 */}
      {task && (
        <div className="rounded-xl border border-violet-800 bg-violet-950/30 px-4 py-3 text-sm text-violet-200">
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 animate-pulse rounded-full bg-violet-400" />
            <span className="flex-1">{task.label}</span>
            <span className="text-xs text-violet-400">{task.status === "PROCESSING" ? "运行中" : "排队中"}</span>
          </div>
          {shots.length > 0 && (
            <div className="mt-2 space-y-1">
              {videoDone < shots.length && (
                <div>
                  <div className="flex items-center justify-between text-xs text-violet-300/70">
                    <span>视频生成</span>
                    <span>{videoDone} / {shots.length}</span>
                  </div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-violet-950">
                    <div className="h-full rounded-full bg-violet-400 transition-all duration-500" style={{ width: `${(videoDone / shots.length) * 100}%` }} />
                  </div>
                </div>
              )}
              {voiceDone < voicedShots && (
                <div>
                  <div className="flex items-center justify-between text-xs text-teal-300/70">
                    <span>配音</span>
                    <span>{voiceDone} / {voicedShots}</span>
                  </div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-teal-950">
                    <div className="h-full rounded-full bg-teal-400 transition-all duration-500" style={{ width: `${voicedShots > 0 ? (voiceDone / voicedShots) * 100 : 0}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 选集 */}
      {(!sub || sub === "compose-episode") && (
      <section id="compose-episode" className="scroll-mt-24 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">① 选择剧集</h3>
            <p className="mt-0.5 text-xs text-zinc-500">分镜图就绪后生成视频，再配音，最后合成导出。</p>
          </div>
        </div>
        {data.episodes.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">暂无剧集，请先在剧本工坊生成分集剧本。</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {data.episodes.map((e) => {
              const v = e.shots.filter((s) => s.videoPath).length;
              const c = e.shots.filter((s) => s.voicePath).length;
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
                      视频{v}/{e.shots.length} · 配音{c}/{e.shots.length}
                    </span>
                  )}
                  {e.finalPath && <span className="ml-1.5 text-[10px] text-emerald-400">✓ 成片</span>}
                </button>
              );
            })}
          </div>
        )}
      </section>
      )}

      {ep && (!sub || sub === "compose-shots") && (
        <>
          {/* 操作条 */}
          <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
            <button
              onClick={() => void post("video", ep.number)}
              disabled={genDisabled || shots.length === 0 || videoDone === shots.length || !shots.some((s) => s.imagePath)}
              className="whitespace-nowrap rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              生成视频（{videoDone}/{shots.length}）
            </button>
            <button
              onClick={() => void post("voice", ep.number)}
              disabled={genDisabled || voicedShots === 0 || voiceDone === voicedShots}
              className="whitespace-nowrap rounded-lg border border-violet-600 px-4 py-1.5 text-sm font-medium text-violet-300 transition hover:bg-violet-950/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              配音（{voiceDone}/{voicedShots}）
            </button>
            <button
              onClick={() => void post("compose", ep.number)}
              disabled={genDisabled || !hasVideo}
              className="whitespace-nowrap rounded-lg border border-emerald-600 px-4 py-1.5 text-sm font-medium text-emerald-300 transition hover:bg-emerald-950/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              合成导出
            </button>
            <select
              value={bgmMood ?? ""}
              onChange={(e) => setBgmMood(e.target.value || null)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300"
            >
              <option value="">无 BGM</option>
              {BGM_MOODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <span className="text-xs text-zinc-500">合成时可选 BGM 情绪（需 storage/bgm/&lt;mood&gt;/ 素材）</span>
          </section>
        </>
      )}

      {/* 成片墙（独立块：三栏模式下「成片预览」子步骤只渲染本区） */}
      {ep && (!sub || sub === "compose-preview") && (
        <FinishedWall
          episodes={data?.episodes ?? []}
          currentNumber={selected}
          projectId={projectId}
        />
      )}

          {/* 镜头列表 */}
          {ep && shots.length > 0 && (!sub || sub === "compose-shots") && (
            <section className="space-y-3">
              {shots.map((s) => {
                const badge = STATUS_BADGE[s.status] ?? { text: s.status, cls: "bg-zinc-800 text-zinc-400" };
                return (
                  <div key={s.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
                    <div className="flex flex-col gap-3 p-3 sm:flex-row">
                      <div className="flex h-28 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-900/80 sm:w-48">
                        {s.videoPath ? (
                          <video
                            src={imgUrl(s.videoPath)}
                            preload="metadata"
                            className="h-full w-full object-cover"
                            muted
                            loop
                          />
                        ) : s.imagePath ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={imgUrl(s.imagePath)} alt={`镜头${s.sequence}`} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="text-xs text-zinc-600">未出图</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-300">#{s.sequence}</span>
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">{s.sceneName ?? "—"}</span>
                          <span className={`rounded px-1.5 py-0.5 ${badge.cls}`}>{badge.text}</span>
                          <span className="ml-auto text-zinc-600">{s.duration}s</span>
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-xs text-zinc-300">{s.action}</p>
                        {s.dialog !== null && (
                          <div className="mt-1 flex items-start gap-1.5">
                            {s.dialogChar && (
                              <span className="mt-1 shrink-0 text-xs font-medium text-amber-300/90">{s.dialogChar}</span>
                            )}
                            <input
                              value={draft[s.id] ?? s.dialog ?? ""}
                              onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                              placeholder="台词"
                              className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 focus:border-violet-600 focus:outline-none"
                            />
                          </div>
                        )}
                        {s.error && <p className="mt-1 text-[10px] text-red-400">{s.error.slice(0, 80)}</p>}
                        {/* P1-5 音频试听：有配音时提供播放器 + 下载 */}
                        {s.voicePath && (
                          <div className="mt-2 flex items-center gap-2">
                            <audio
                              controls
                              preload="none"
                              className="h-8 min-w-0 flex-1"
                              src={imgUrl(s.voicePath)}
                            />
                            <a
                              href={imgUrl(s.voicePath)}
                              download
                              className="shrink-0 text-[10px] text-teal-400/80 underline-offset-2 hover:underline"
                            >
                              下载
                            </a>
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {s.voicePath && <span className="text-[10px] text-teal-400">配音 ✓</span>}
                          {s.subtitlePath && <span className="text-[10px] text-zinc-600">字幕 ✓</span>}
                          <div className="ml-auto flex flex-wrap items-center gap-1.5">
                            {s.dialog !== null && (draft[s.id] ?? s.dialog ?? "") !== (s.dialog ?? "") && (
                              <button
                                onClick={() => void saveDialog(s.id)}
                                disabled={saving === s.id || genDisabled}
                                className="whitespace-nowrap rounded-md border border-amber-700/60 px-2 py-1 text-[11px] text-amber-300 transition hover:bg-amber-950/40 disabled:opacity-40"
                              >
                                {saving === s.id ? "保存中…" : "保存台词"}
                              </button>
                            )}
                            {s.imagePath && s.status !== "VIDEO_GENERATING" && (
                              <button
                                onClick={() => void post("video", ep.number, s.id)}
                                disabled={genDisabled}
                                className="whitespace-nowrap rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
                              >
                                {s.videoPath ? "重新生成" : "生成视频"}
                              </button>
                            )}
                            {s.dialog && (s.videoPath || s.imagePath) && s.status !== "VOICE_GENERATING" && (
                              <button
                                onClick={() => void post("voice", ep.number, s.id)}
                                disabled={genDisabled}
                                className="whitespace-nowrap rounded-md border border-fuchsia-700/60 px-2 py-1 text-[11px] text-fuchsia-300 transition hover:bg-fuchsia-950/40 disabled:opacity-40"
                              >
                                {s.voicePath ? "重新配音" : "配音"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          )}

      <p className="text-center text-xs text-zinc-600">
        当前项目：{projectTitle} · 视频 = 分镜图 + 微动态提示词；配音 = 台词 + 角色音色；合成 = ffmpeg 逐镜头混音拼接
      </p>
    </div>
  );
}
