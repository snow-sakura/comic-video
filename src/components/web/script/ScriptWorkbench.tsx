"use client";

/**
 * 剧本工坊工作台（M1）
 * 流程：上传小说 → 提炼角色 → 生成大纲 → 逐集生成剧本
 * 每步通过 script-agent API 入队，轮询 runningTask 直至完成。
 */
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/lib/hooks/use-polling";
import { useAutoError } from "@/lib/hooks/use-auto-error";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";

// ========== 类型 ==========

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

const STAGE_ORDER = ["none", "uploaded", "characters", "outline", "script"];

// ========== 组件 ==========

export default function ScriptWorkbench({
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useAutoError();
  const [novelText, setNovelText] = useState("");
  const [fileName, setFileName] = useState("");
  const [episodeScripts, setEpisodeScripts] = useState<Record<number, EpisodeScript>>({});
  const [openEps, setOpenEps] = useState<Set<number>>(new Set());
  // 定制集数（提炼角色后覆盖）：默认跟随项目设定
  const [epCount, setEpCount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/script-agent`);
      if (!res.ok) throw new Error("加载失败");
      const d: WorkbenchData = await res.json();
      setData(d);
      // 集数输入默认值与项目同步（仅在用户未手动修改时跟随）
      setEpCount((prev) => prev || String(d.episodeCount ?? 6));
      // 如果 API 已返回剧本内容，直接使用（避免二次请求）
      if (d.episodeScripts) {
        setEpisodeScripts(d.episodeScripts as Record<number, EpisodeScript>);
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

  // 智能轮询：仅 runningTask 存在时启动，指数退避 2s→4s→8s→15s
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
          // 409 并发保护：不算错误，刷新后由轮询/任务状态接管
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
  }, [novelText, projectId, load]);

  const pickFile = useCallback(async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setNovelText(text);
  }, []);

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

  const stageIndex = STAGE_ORDER.indexOf(data.stage) >= 0 ? STAGE_ORDER.indexOf(data.stage) : 1;
  const task = data.runningTask;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {/* 阶段进度条 */}
      {!sub && (
      <div className="flex items-center gap-1 text-xs">
        {[
          { k: "uploaded", label: "上传小说" },
          { k: "characters", label: "提炼角色" },
          { k: "outline", label: "生成大纲" },
          { k: "script", label: "生成剧本" },
        ].map((s, i) => (
          <div key={s.k} className="flex flex-1 items-center gap-1">
            <div
              className={`flex h-6 flex-1 items-center justify-center rounded-md font-medium ${
                stageIndex > i
                  ? "bg-violet-600/80 text-white"
                  : stageIndex === i
                    ? "border border-violet-500 text-violet-300"
                    : "bg-zinc-900 text-zinc-600"
              }`}
            >
              {s.label}
            </div>
            {i < 3 && <div className="h-px w-2 bg-zinc-700" />}
          </div>
        ))}
      </div>
      )}

      {/* 运行中任务提示 */}
      {task && (
        <div className="flex items-center gap-3 rounded-xl border border-violet-800 bg-violet-950/30 px-4 py-3 text-sm text-violet-200">
          <span className="h-3 w-3 animate-pulse rounded-full bg-violet-400" />
          <span className="flex-1">{task.label}</span>
          <span className="text-xs text-violet-400">{task.status === "PROCESSING" ? "运行中" : "排队中"}</span>
        </div>
      )}

      {/* ① 上传小说 */}
      {(!sub || sub === "script-upload") && (
      <section id="script-upload" className="scroll-mt-24 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">① 上传小说</h3>
          {data.hasNovel && (
            <span className="rounded-full bg-emerald-950 px-3 py-1 text-xs text-emerald-300">
              已导入 · {data.chapters} 章
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-zinc-500">粘贴正文或上传 .txt 文件（≤3MB），自动识别章节。</p>
        <textarea
          value={novelText}
          onChange={(e) => setNovelText(e.target.value)}
          placeholder="粘贴小说正文…（也可选择文件）"
          className="mt-3 h-32 w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-sm outline-none transition focus:border-violet-500"
          disabled={busy}
        />
        <div className="mt-3 flex items-center gap-3">
          <label className="cursor-pointer whitespace-nowrap rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500">
            {fileName || "选择 .txt 文件"}
            <input
              type="file"
              accept=".txt,.md,text/plain"
              className="hidden"
              onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </label>
          {fileName && <span className="text-xs text-zinc-500">{fileName}（{novelText.length} 字）</span>}
          <button
            onClick={() => void uploadNovel()}
            disabled={busy || !novelText.trim()}
            className="ml-auto whitespace-nowrap rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "处理中…" : data.hasNovel ? "更新小说" : "导入小说"}
          </button>
        </div>
      </section>
      )}

      {/* ② 角色提炼 */}
      {(!sub || sub === "script-character") && (
      <section id="script-character" className="scroll-mt-24 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">② 提炼角色</h3>
            <p className="mt-0.5 text-xs text-zinc-500">LLM 从小说提炼 4-8 个关键角色（外貌 / 性格 / 配音建议），无 Key 时自动启发式提取。</p>
          </div>
          <button
            onClick={() => void trigger("characters")}
            disabled={busy || !!task || !data.hasNovel}
            className="whitespace-nowrap rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提炼角色
          </button>
        </div>
        {data.characters.length > 0 && (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.characters.map((c) => (
              <div key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{c.name}</span>
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
                    {ROLE_LABEL[c.role] ?? c.role}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-xs text-zinc-400">
                  <p><span className="text-zinc-600">外貌</span> {c.appearance.hair} / {c.appearance.costume}</p>
                  <p><span className="text-zinc-600">性格</span> {c.personality.speechStyle}</p>
                  {c.voiceName && <p><span className="text-zinc-600">配音</span> {c.voiceName}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* ③ 大纲 */}
      {(!sub || sub === "script-outline") && (
      <section id="script-outline" className="scroll-mt-24 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">③ 分集大纲</h3>
            <p className="mt-0.5 text-xs text-zinc-500">总编剧 Agent 生成核心梗概 + 分集大纲（每集带集尾钩子）。</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-zinc-400">
              集数
              <input
                type="number"
                min={1}
                max={60}
                value={epCount}
                onChange={(e) => setEpCount(e.target.value)}
                disabled={busy || !!task}
                className="w-14 rounded-md border border-zinc-800 bg-zinc-950/60 px-1.5 py-1 text-center text-sm outline-none transition focus:border-violet-500"
              />
              集
            </label>
            <button
              onClick={() => void trigger("outline", undefined, Number(epCount) || undefined)}
              disabled={busy || !!task || data.characters.length === 0}
              className="whitespace-nowrap rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              生成大纲（{epCount || "?"} 集）
            </button>
          </div>
        </div>
        {data.episodes.length > 0 && (
          <p className="mt-2 text-[11px] text-amber-300/70">
            当前 {data.episodes.length} 集大纲；修改集数后重新生成将覆盖并按新集数同步后续流程。
          </p>
        )}
        {data.logline && (
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-xs text-zinc-500">核心梗概</p>
            <p className="mt-1 text-sm">{data.logline}</p>
            {data.worldView && <p className="mt-2 text-xs text-zinc-400">世界观：{data.worldView}</p>}
          </div>
        )}
        {data.episodes.length > 0 && (
          <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.episodes.map((e) => (
              <div key={e.id} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-sm">
                <div className="font-medium">第{e.number}集 · {e.title}</div>
                <div className="mt-1 text-xs text-zinc-500">钩子：{e.hookEnd}</div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* ④ 剧本 */}
      {(!sub || sub === "script-scripts") && (
      <section id="script-scripts" className="scroll-mt-24 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">④ 分集剧本</h3>
            <p className="mt-0.5 text-xs text-zinc-500">逐集生成完整剧本（场景 / 动作 / 台词 / 情绪），供分镜车间使用。</p>
          </div>
          <span className="text-xs text-zinc-500">{data.generatedEpisodes} / {data.episodes.length} 集</span>
        </div>
        {data.episodes.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">请先生成大纲。</p>
        ) : (
          <div className="mt-4 space-y-3">
            {data.episodes.map((e) => {
              const script = episodeScripts[e.number];
              const done = Boolean(script && Array.isArray(script.scenes) && script.scenes.length > 0);
              return (
                <div key={e.id} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        setOpenEps((prev) => {
                          const next = new Set(prev);
                          if (next.has(e.number)) next.delete(e.number);
                          else next.add(e.number);
                          return next;
                        })
                      }
                      aria-expanded={openEps.has(e.number)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-zinc-800 text-xs text-zinc-400 transition hover:border-violet-500 hover:text-violet-300"
                      title={openEps.has(e.number) ? "收起该集剧本" : "展开该集剧本"}
                    >
                      {openEps.has(e.number) ? "▾" : "▸"}
                    </button>
                    <span className="min-w-0 truncate font-medium">{`第${e.number}集 · ${e.title}`}</span>
                    {done && <span className="shrink-0 rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-300">已生成</span>}
                    <button
                      onClick={() => void trigger("script", e.number)}
                      disabled={busy || !!task || done}
                      className="ml-auto shrink-0 whitespace-nowrap rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition hover:border-violet-500 hover:text-violet-300 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {done ? "已生成（禁用防覆盖）" : "生成剧本"}
                    </button>
                  </div>
                  {done && openEps.has(e.number) && (
                    <div className="mt-3 space-y-3">
                      {script.scenes.map((s, i) => (
                        <div key={i} className="rounded-lg border border-zinc-800/70 bg-zinc-900/50 p-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded bg-zinc-800 px-2 py-0.5 font-medium text-zinc-300">场景 {i + 1}</span>
                            <span className="text-zinc-400">{s.location}</span>
                            <span className="text-zinc-600">·</span>
                            <span className="text-zinc-400">{s.time}</span>
                            {s.characters.length > 0 && (
                              <>
                                <span className="text-zinc-600">·</span>
                                <span className="text-violet-300">{s.characters.join("、")}</span>
                              </>
                            )}
                          </div>
                          {s.action && <p className="mt-2 text-sm text-zinc-300">{s.action}</p>}
                          {s.dialogs.map((d, j) => (
                            <div key={j} className="mt-2 flex items-start gap-2 text-sm">
                              <span className="font-medium text-zinc-200">{d.char}</span>
                              <span className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-amber-300/80">{d.emotion}</span>
                              <span className="text-zinc-300">{d.text}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                      <p className="text-xs text-zinc-500">集尾钩子：{script.hookEnd}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      )}

      <p className="text-center text-xs text-zinc-600">
        当前项目：{projectTitle} · 全部任务经队列异步执行，状态自动刷新
      </p>
    </div>
  );
}
