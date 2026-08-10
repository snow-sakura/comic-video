"use client";

/**
 * 视频合成厂工作台（M4）
 * ① 选集 → ② 生成视频（分镜图 → 可灵微动态）→ ③ 配音（TTS）→ ④ 合成导出（ffmpeg + 可选 BGM）
 * 运行中任务 2s 轮询。
 */
import { useCallback, useEffect, useRef, useState } from "react";

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

// ========== 组件 ==========

export default function ComposeWorkbench({
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
  const [bgmMood, setBgmMood] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    void load();
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
  }, [data?.runningTask?.id, load]);

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
  // 按产物路径统计（不依赖状态枚举，避免后续状态覆盖导致计数失真）
  const videoDone = shots.filter((s) => s.videoPath).length;
  const voiceDone = shots.filter((s) => s.voicePath).length;
  const voicedShots = shots.filter((s) => s.dialog).length;
  const hasVideo = shots.some((s) => s.videoPath);
  const composed = !!ep?.finalPath;
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

      {ep && (
        <>
          {/* 操作条 */}
          <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
            <button
              onClick={() => void post("video", ep.number)}
              disabled={genDisabled || shots.length === 0 || videoDone === shots.length || !shots.some((s) => s.imagePath)}
              className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              生成视频（{videoDone}/{shots.length}）
            </button>
            <button
              onClick={() => void post("voice", ep.number)}
              disabled={genDisabled || voicedShots === 0 || voiceDone === voicedShots}
              className="rounded-lg border border-violet-600 px-4 py-1.5 text-sm font-medium text-violet-300 transition hover:bg-violet-950/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              配音（{voiceDone}/{voicedShots}）
            </button>
            <button
              onClick={() => void post("compose", ep.number)}
              disabled={genDisabled || !hasVideo}
              className="rounded-lg border border-emerald-600 px-4 py-1.5 text-sm font-medium text-emerald-300 transition hover:bg-emerald-950/40 disabled:cursor-not-allowed disabled:opacity-40"
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

          {/* 成片播放 */}
          {composed && ep.finalPath && (
            <section className="rounded-2xl border border-emerald-800 bg-emerald-950/20 p-4">
              <h3 className="mb-3 font-semibold text-emerald-200">成片预览 · 第{ep.number}集</h3>
              <video
                controls
                preload="metadata"
                crossOrigin="anonymous"
                className="aspect-video w-full rounded-lg bg-black"
                src={imgUrl(ep.finalPath)}
              >
                <track
                  kind="subtitles"
                  srcLang="zh"
                  label="中文字幕"
                  default
                  src={imgUrl(ep.finalPath.replace(/\.mp4$/, ".vtt"))}
                />
              </video>
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href={imgUrl(ep.finalPath)}
                  download
                  className="inline-block rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500"
                >
                  下载成片
                </a>
                <a
                  href={imgUrl(ep.finalPath.replace(/\.mp4$/, ".srt"))}
                  download
                  className="inline-block rounded-lg bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-100 transition hover:bg-zinc-600"
                >
                  下载 SRT 字幕
                </a>
              </div>
            </section>
          )}

          {/* 镜头列表 */}
          {shots.length > 0 && (
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
                          <img src={imgUrl(s.imagePath)} alt={`镜头${s.sequence}`} className="h-full w-full object-cover" />
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
                                className="rounded-md border border-amber-700/60 px-2 py-1 text-[11px] text-amber-300 transition hover:bg-amber-950/40 disabled:opacity-40"
                              >
                                {saving === s.id ? "保存中…" : "保存台词"}
                              </button>
                            )}
                            {s.imagePath && s.status !== "VIDEO_GENERATING" && (
                              <button
                                onClick={() => void post("video", ep.number, s.id)}
                                disabled={genDisabled}
                                className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
                              >
                                {s.videoPath ? "重新生成" : "生成视频"}
                              </button>
                            )}
                            {s.dialog && (s.videoPath || s.imagePath) && s.status !== "VOICE_GENERATING" && (
                              <button
                                onClick={() => void post("voice", ep.number, s.id)}
                                disabled={genDisabled}
                                className="rounded-md border border-fuchsia-700/60 px-2 py-1 text-[11px] text-fuchsia-300 transition hover:bg-fuchsia-950/40 disabled:opacity-40"
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
        </>
      )}

      <p className="text-center text-xs text-zinc-600">
        当前项目：{projectTitle} · 视频 = 分镜图 + 微动态提示词；配音 = 台词 + 角色音色；合成 = ffmpeg 逐镜头混音拼接
      </p>
    </div>
  );
}
