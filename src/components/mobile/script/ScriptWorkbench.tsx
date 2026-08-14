"use client";

/**
 * 移动端 · 剧本工坊工作台
 * 流程：上传小说 → 提炼角色 → 生成大纲 → 逐集生成剧本
 * 复用 web 端相同 API（/script-agent、/novel），UI 针对移动端单列触控优化。
 */
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/lib/hooks/use-polling";
import { useAutoError } from "@/lib/hooks/use-auto-error";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";

interface Character {
  id: string;
  name: string;
  role: string;
  appearance: Record<string, string>;
  personality: Record<string, string>;
  voiceName: string | null;
}

interface Episode {
  id: string;
  number: number;
  title: string | null;
  hookEnd: string | null;
  status: string;
}

interface RunningTask {
  id: string;
  label: string;
  status: string;
  error: string | null;
}

interface EpisodeScript {
  number: number;
  title: string;
  hookEnd: string;
  scenes: {
    location: string;
    time: string;
    characters: string[];
    action: string;
    dialogs: { char: string; text: string; emotion: string }[];
  }[];
}

interface WorkbenchData {
  stage: string;
  hasNovel: boolean;
  episodeCount: number;
  chapters: number;
  characters: Character[];
  logline: string | null;
  worldView: string | null;
  generatedEpisodes: number;
  episodes: Episode[];
  runningTask: RunningTask | null;
  episodeScripts?: Record<number, EpisodeScript>;
}

const ROLE_LABEL: Record<string, string> = {
  protagonist: "主角",
  supporting: "配角",
  antagonist: "反派",
  utility: "功能性",
};

export default function ScriptWorkbench({
  projectId,
  sub,
}: {
  projectId: string;
  projectTitle: string;
  sub?: string;
}) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useAutoError();
  const [novelText, setNovelText] = useState("");
  const [fileName, setFileName] = useState("");
  const [episodeScripts, setEpisodeScripts] = useState<Record<number, EpisodeScript>>({});
  const [openEps, setOpenEps] = useState<Set<number>>(new Set());
  const [epCount, setEpCount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/script-agent`);
      if (!res.ok) throw new Error("加载失败");
      const d: WorkbenchData = await res.json();
      setData(d);
      setEpCount((prev) => prev || String(d.episodeCount ?? 6));
      if (d.episodeScripts) {
        setEpisodeScripts(d.episodeScripts as Record<number, EpisodeScript>);
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

  const trigger = useCallback(
    async (stage: string, episodeNumber?: number, episodeCount?: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/script-agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, episodeNumber, episodeCount }),
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

  const uploadNovel = useCallback(async () => {
    if (!novelText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/novel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: novelText }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "上传失败");
      setNovelText("");
      setFileName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  }, [novelText, projectId, load, setError]);

  const pickFile = useCallback(async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setNovelText(text);
  }, []);

  if (loading) return <WorkbenchSkeleton />;

  const show = (id: string) => !sub || sub === id;
  const rt = data?.runningTask;
  const running = rt && (rt.status === "QUEUED" || rt.status === "PROCESSING");

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      {/* 运行中任务提示 */}
      {running && rt && (
        <div className="rounded-lg border border-violet-700 bg-violet-950/30 px-3 py-2 text-xs text-violet-200">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" /> {rt.label}（{rt.status === "QUEUED" ? "排队中" : "处理中"}）
        </div>
      )}

      {/* 上传小说 */}
      {show("script-upload") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold">上传小说</h3>
          {data?.hasNovel ? (
            <p className="text-xs text-emerald-400">✓ 已导入小说（{data.chapters ?? 0} 章）</p>
          ) : (
            <>
              <label className="mb-2 block">
                <span className="mb-1 block text-[11px] text-zinc-500">选择 .txt 文件</span>
                <input
                  type="file"
                  accept=".txt,text/plain"
                  onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-[11px] text-zinc-400 file:mr-2 file:rounded file:border-0 file:bg-zinc-700 file:px-2 file:py-1 file:text-[11px] file:text-white"
                />
                {fileName && <span className="mt-1 block text-[10px] text-zinc-500">{fileName}</span>}
              </label>
              <textarea
                value={novelText}
                onChange={(e) => setNovelText(e.target.value)}
                placeholder="或直接粘贴小说文本…"
                rows={4}
                className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-xs outline-none placeholder:text-zinc-500 focus:border-violet-500"
              />
              <button
                onClick={() => void uploadNovel()}
                disabled={busy || !novelText.trim()}
                className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? "处理中…" : "上传小说"}
              </button>
            </>
          )}
        </section>
      )}

      {/* 提炼角色 */}
      {show("script-character") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">角色列表</h3>
            <button
              onClick={() => void trigger("characters")}
              disabled={busy || !data?.hasNovel}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "…" : "提炼角色"}
            </button>
          </div>
          {data && data.characters.length > 0 ? (
            <ul className="space-y-2">
              {data.characters.map((c) => (
                <li key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm">{c.name}</span>
                    <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      {ROLE_LABEL[c.role] ?? c.role}
                    </span>
                  </div>
                  {c.appearance && Object.keys(c.appearance).length > 0 && (
                    <p className="mt-1 text-[11px] text-zinc-500 line-clamp-2">
                      {Object.entries(c.appearance).map(([k, v]) => `${k}: ${v}`).join("；")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">{data?.hasNovel ? "尚未提炼角色，点击右上角按钮生成" : "请先上传小说"}</p>
          )}
        </section>
      )}

      {/* 分集大纲 */}
      {show("script-outline") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">分集大纲</h3>
            <button
              onClick={() => void trigger("outline", undefined, Number(epCount))}
              disabled={busy || (data?.characters.length ?? 0) === 0}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "…" : "生成大纲"}
            </button>
          </div>
          <label className="mb-2 block">
            <span className="mb-1 block text-[11px] text-zinc-500">目标集数</span>
            <input
              type="number"
              value={epCount}
              onChange={(e) => setEpCount(e.target.value)}
              min={1}
              max={30}
              className="w-20 rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-sm outline-none focus:border-violet-500"
            />
          </label>
          {data?.logline && (
            <div className="mb-2 rounded-lg bg-zinc-950/40 p-2 text-[11px] text-zinc-300">
              <span className="text-zinc-500">故事梗概：</span>
              {data.logline}
            </div>
          )}
          {data && data.episodes.length > 0 ? (
            <ul className="space-y-1">
              {data.episodes.map((ep) => (
                <li key={ep.id} className="flex items-center gap-2 text-xs">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-[10px]">{ep.number}</span>
                  <span className="flex-1 truncate text-zinc-300">{ep.title || "未命名"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">{(data?.characters.length ?? 0) > 0 ? "尚未生成大纲" : "请先提炼角色"}</p>
          )}
        </section>
      )}

      {/* 分集剧本 */}
      {show("script-scripts") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">分集剧本</h3>
            <button
              onClick={() => void trigger("script", (data?.generatedEpisodes ?? 0) + 1)}
              disabled={busy || (data?.episodes.length ?? 0) === 0}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "…" : `生成第 ${(data?.generatedEpisodes ?? 0) + 1} 集`}
            </button>
          </div>
          {data && data.episodes.length > 0 ? (
            <ul className="space-y-1.5">
              {data.episodes.map((ep) => {
                const script = episodeScripts[ep.number];
                const hasScript = Boolean(script);
                const isOpen = openEps.has(ep.number);
                return (
                  <li key={ep.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40">
                    <button
                      onClick={() =>
                        setOpenEps((prev) => {
                          const next = new Set(prev);
                          if (next.has(ep.number)) next.delete(ep.number);
                          else next.add(ep.number);
                          return next;
                        })
                      }
                      disabled={!hasScript}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs disabled:opacity-60"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-[10px]">{ep.number}</span>
                      <span className="flex-1 truncate text-zinc-300">{ep.title || "未命名"}</span>
                      {hasScript && <span className="text-[10px] text-emerald-400">✓ 剧本</span>}
                      {hasScript && <span className={`transition ${isOpen ? "rotate-180" : ""}`}>▾</span>}
                    </button>
                    {isOpen && hasScript && script && (
                      <div className="border-t border-zinc-800 px-2.5 py-2 text-[11px] text-zinc-400">
                        {script.hookEnd && <p className="mb-1 text-zinc-500">悬念：{script.hookEnd}</p>}
                        {script.scenes.map((sc, i) => (
                          <div key={i} className="mb-1.5 rounded bg-zinc-900/60 p-1.5">
                            <p className="text-zinc-500">{sc.location} · {sc.time}</p>
                            <p className="mt-0.5 text-zinc-300">{sc.action}</p>
                            {sc.dialogs.map((d, j) => (
                              <p key={j} className="mt-0.5">
                                <span className="text-violet-300">{d.char}</span>
                                <span className="text-zinc-500">（{d.emotion}）</span>
                                ：{d.text}
                              </p>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">请先生成分集大纲</p>
          )}
        </section>
      )}
    </div>
  );
}
