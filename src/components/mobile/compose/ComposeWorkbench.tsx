"use client";

/**
 * 移动端 · 视频合成厂工作台
 * ① 选集 → ② 生成视频（分镜图→微动态）→ ③ 配音（TTS）→ ④ 合成导出
 * 复用 web 端相同 API（/compose、/shots），UI 针对移动端单列触控优化。
 */
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/lib/hooks/use-polling";
import { useAutoError } from "@/lib/hooks/use-auto-error";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";

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

const BGM_MOODS: { id: string; label: string }[] = [
  { id: "romance", label: "浪漫" },
  { id: "tension", label: "紧张" },
  { id: "warmth", label: "温暖" },
  { id: "sadness", label: "悲伤" },
  { id: "excitement", label: "激昂" },
  { id: "mystery", label: "神秘" },
  { id: "calm", label: "宁静" },
  { id: "epic", label: "史诗" },
  { id: "humor", label: "幽默" },
  { id: "horror", label: "惊悚" },
];

export default function ComposeWorkbench({
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
  const [bgmMood, setBgmMood] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [editingShot, setEditingShot] = useState<string | null>(null);

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
        const res = await fetch(`/api/projects/${projectId}/compose`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, episodeNumber, shotId, bgmMood }),
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
    [projectId, load, bgmMood, setError],
  );

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
        setEditingShot(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "保存失败");
      } finally {
        setSaving(null);
      }
    },
    [projectId, draft, load, setError],
  );

  if (loading) return <WorkbenchSkeleton />;
  if (!data) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
        加载失败 ·{" "}
        <button className="text-violet-400 hover:underline" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  const show = (id: string) => !sub || sub === id;
  const rt = data.runningTask;
  const running = rt && (rt.status === "QUEUED" || rt.status === "PROCESSING");
  const currentEp = data.episodes.find((e) => e.number === selected) ?? null;
  const finished = data.episodes.filter((e) => e.finalPath);

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

      {/* 选集 */}
      {show("compose-episode") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold">选择剧集</h3>
          {data.episodes.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1.5">
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
                    第{ep.number}集{ep.finalPath ? " ✓" : ""}
                  </button>
                ))}
              </div>
              {currentEp && (
                <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div className="rounded-lg bg-zinc-950/40 p-2">
                    <div className="text-base font-bold text-violet-300">{currentEp.shots.length}</div>
                    <div className="text-zinc-500">镜头</div>
                  </div>
                  <div className="rounded-lg bg-zinc-950/40 p-2">
                    <div className="text-base font-bold text-emerald-300">
                      {currentEp.shots.filter((s) => s.videoPath).length}
                    </div>
                    <div className="text-zinc-500">已生成视频</div>
                  </div>
                  <div className="rounded-lg bg-zinc-950/40 p-2">
                    <div className="text-base font-bold text-teal-300">
                      {currentEp.shots.filter((s) => s.voicePath).length}
                    </div>
                    <div className="text-zinc-500">已配音</div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-zinc-500">请先在分镜车间完成出图</p>
          )}
        </section>
      )}

      {/* 镜头·配音 */}
      {show("compose-shots") && currentEp && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              onClick={() => selected && void post("video", selected)}
              disabled={busy || !selected || currentEp.shots.length === 0}
              className="flex-1 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "…" : "生成全部视频"}
            </button>
            <button
              onClick={() => selected && void post("voice", selected)}
              disabled={busy || !selected || currentEp.shots.length === 0}
              className="flex-1 rounded-lg border border-teal-700 bg-teal-950/40 px-3 py-2 text-xs font-medium text-teal-300 disabled:opacity-40"
            >
              {busy ? "…" : "全部配音"}
            </button>
          </div>

          <ul className="space-y-2">
            {currentEp.shots.map((s) => {
              const badge = STATUS_BADGE[s.status] ?? { text: s.status, cls: "bg-zinc-800 text-zinc-400" };
              const isEditing = editingShot === s.id;
              return (
                <li key={s.id} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/40">
                  <div className="flex gap-2.5 p-2.5">
                    {s.videoPath ? (
                      <video
                        src={imgUrl(s.videoPath)}
                        preload="metadata"
                        muted
                        playsInline
                        className="h-16 w-16 shrink-0 rounded object-cover"
                      />
                    ) : s.imagePath ? (
                      <img src={imgUrl(s.imagePath)} alt={`镜头${s.sequence}`} className="h-16 w-16 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] text-zinc-600">无图</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium">镜头 {s.sequence}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                      </div>
                      {s.dialog && (
                        <p className="mt-0.5 text-[11px] text-zinc-400 line-clamp-2">
                          {s.dialogChar ? `${s.dialogChar}：` : ""}
                          {s.dialog}
                        </p>
                      )}
                      {s.voicePath && <span className="mt-0.5 inline-block text-[10px] text-teal-400">🎤 已配音</span>}
                      {s.error && <p className="mt-0.5 text-[10px] text-red-400">{s.error}</p>}
                    </div>
                  </div>
                  {/* 操作 */}
                  <div className="flex flex-wrap gap-1.5 border-t border-zinc-800 px-2.5 py-1.5">
                    <button
                      onClick={() => void post("video", selected!, s.id)}
                      disabled={busy}
                      className="rounded bg-violet-600 px-2 py-0.5 text-[10px] text-white disabled:opacity-40"
                    >
                      重生成视频
                    </button>
                    <button
                      onClick={() => void post("voice", selected!, s.id)}
                      disabled={busy}
                      className="rounded border border-teal-700 px-2 py-0.5 text-[10px] text-teal-300 disabled:opacity-40"
                    >
                      重新配音
                    </button>
                    <button
                      onClick={() => {
                        setEditingShot(isEditing ? null : s.id);
                        setDraft((d) => ({ ...d, [s.id]: d[s.id] ?? s.dialog ?? "" }));
                      }}
                      className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300"
                    >
                      {isEditing ? "收起" : "改台词"}
                    </button>
                  </div>
                  {/* 台词编辑 */}
                  {isEditing && (
                    <div className="border-t border-zinc-800 bg-zinc-900/60 p-2.5">
                      <textarea
                        value={draft[s.id] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                        rows={2}
                        placeholder="编辑台词…"
                        className="mb-1.5 w-full rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-[11px] outline-none focus:border-violet-500"
                      />
                      <button
                        onClick={() => void saveDialog(s.id)}
                        disabled={saving === s.id}
                        className="rounded bg-teal-600 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                      >
                        {saving === s.id ? "保存中…" : "保存台词（自动作废旧配音）"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 成片预览 + 合成导出 */}
      {show("compose-preview") && (
        <section className="rounded-xl border border-emerald-800 bg-emerald-950/20 p-4">
          <h3 className="mb-2 text-sm font-semibold text-emerald-200">成片预览</h3>

          {/* BGM 情绪选择 */}
          <div className="mb-3">
            <p className="mb-1.5 text-[11px] text-zinc-500">背景音乐情绪（合成时使用）</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setBgmMood(null)}
                className={`rounded-full border px-2.5 py-1 text-[11px] ${
                  bgmMood === null ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-700 text-zinc-400"
                }`}
              >
                不使用
              </button>
              {BGM_MOODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setBgmMood(m.id)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${
                    bgmMood === m.id ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-700 text-zinc-400"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* 合成按钮 */}
          <button
            onClick={() => selected && void post("compose", selected)}
            disabled={busy || !selected}
            className="mb-3 w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "处理中…" : `合成第 ${selected ?? "?"} 集（含配音${bgmMood ? "+BGM" : ""}）`}
          </button>

          {/* 已成片列表 */}
          {finished.length === 0 ? (
            <p className="py-6 text-center text-xs text-zinc-500">
              暂无成片，请先完成镜头视频与配音，再点击「合成」
            </p>
          ) : (
            <ul className="space-y-3">
              {finished.map((ep) => (
                <li key={ep.id} className="overflow-hidden rounded-lg border border-zinc-700 bg-black">
                  <video
                    src={imgUrl(ep.finalPath!)}
                    controls
                    preload="metadata"
                    playsInline
                    className="aspect-video w-full bg-black"
                  />
                  <div className="flex items-center justify-between px-3 py-2">
                    <div>
                      <span className="text-sm font-medium text-white">第{ep.number}集</span>
                      <span className="ml-1.5 text-[11px] text-zinc-400">{ep.title || ""}</span>
                    </div>
                    <a
                      href={imgUrl(ep.finalPath!)}
                      download
                      className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white"
                    >
                      下载
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
