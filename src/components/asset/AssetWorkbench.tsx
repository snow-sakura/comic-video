"use client";

/**
 * 资产工厂工作台（M2）
 * 角色定妆照 / 场景空镜 / 道具设计稿生成 + 一致性锁定（APPROVED 后作为分镜参考图）。
 * 任务走 image 队列异步执行，运行中 2s 轮询。
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ========== 类型 ==========

interface AssetCharacter {
  id: string;
  name: string;
  role: string;
  status: string;
  refImageIds: string[];
  appearance: Record<string, string>;
  voiceName: string | null;
}

interface AssetScene {
  id: string;
  name: string;
  description: string | null;
  mood: string | null;
  status: string;
  refImageIds: string[];
}

interface AssetProp {
  id: string;
  name: string;
  status: string;
  imageIds: string[];
  meta: Record<string, string> | null;
}

interface RunningTask {
  id: string;
  label: string;
  status: string;
  error: string | null;
}

interface WorkbenchData {
  characters: AssetCharacter[];
  scenes: AssetScene[];
  props: AssetProp[];
  runningTask: RunningTask | null;
}

const ROLE_LABEL: Record<string, string> = {
  protagonist: "主角",
  supporting: "配角",
  antagonist: "反派",
  utility: "功能性",
};

const imgUrl = (p: string) => `/api/files?path=${encodeURIComponent(p)}`;

// ========== 组件 ==========

export default function AssetWorkbench({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [propName, setPropName] = useState("");
  const [propDesc, setPropDesc] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/assets`);
      if (!res.ok) throw new Error("加载失败");
      const d: WorkbenchData = await res.json();
      setData(d);
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

  const generate = useCallback(
    async (kind: string, refId?: string, extra?: Record<string, string>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, refId, ...extra }),
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

  const lock = useCallback(
    async (kind: string, refId: string, status: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/assets`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, refId, status }),
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
  const approved = (s: string) => s === "APPROVED";
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
          <span className="text-xs text-violet-400">{task.status === "PROCESSING" ? "生成中" : "排队中"}</span>
        </div>
      )}

      {/* ① 角色定妆照 */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">① 角色定妆照</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              为每个角色生成 3 张定妆照（正面/侧面/全身），锁定后作为后续分镜的参考图，保证跨镜头一致性。
            </p>
          </div>
          <span className="text-xs text-zinc-500">
            {data.characters.filter((c) => approved(c.status)).length} / {data.characters.length} 已锁定
          </span>
        </div>
        {data.characters.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">暂无角色，请先在剧本工坊完成角色提炼。</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.characters.map((c) => {
              const first = c.refImageIds[0];
              return (
                <div key={c.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
                  <div className="flex h-44 items-center justify-center bg-zinc-900/80">
                    {first ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imgUrl(first)} alt={c.name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-xs text-zinc-600">未生成</span>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
                        {ROLE_LABEL[c.role] ?? c.role}
                      </span>
                      {approved(c.status) ? (
                        <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-300">已锁定</span>
                      ) : (
                        <span className="rounded-full bg-amber-950/60 px-2 py-0.5 text-[10px] text-amber-300/80">草稿</span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      {c.refImageIds.length > 1 && (
                        <div className="flex gap-1">
                          {c.refImageIds.slice(0, 4).map((p, i) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={i} src={imgUrl(p)} alt="" className="h-8 w-8 rounded border border-zinc-800 object-cover" />
                          ))}
                        </div>
                      )}
                      <div className="ml-auto flex gap-1.5">
                        {!approved(c.status) && (
                          <button
                            onClick={() => void lock("character", c.id, "APPROVED")}
                            disabled={busy || c.refImageIds.length === 0}
                            className="rounded-md border border-emerald-700/60 px-2 py-1 text-[11px] text-emerald-300 transition hover:bg-emerald-950/50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            锁定
                          </button>
                        )}
                        {approved(c.status) && (
                          <button
                            onClick={() => void lock("character", c.id, "DRAFTING")}
                            disabled={busy}
                            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500"
                          >
                            解锁
                          </button>
                        )}
                        <button
                          onClick={() => void generate("character", c.id)}
                          disabled={genDisabled}
                          className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {c.refImageIds.length > 0 ? (approved(c.status) ? "补全" : "重新生成") : "生成"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ② 场景空镜 */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">② 场景空镜</h3>
            <p className="mt-0.5 text-xs text-zinc-500">从剧本自动提取场景列表，生成无人物环境图，锁定后作为分镜背景参考。</p>
          </div>
          <span className="text-xs text-zinc-500">
            {data.scenes.filter((s) => approved(s.status)).length} / {data.scenes.length} 已锁定
          </span>
        </div>
        {data.scenes.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">暂无场景，请先在剧本工坊生成分集剧本。</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.scenes.map((s) => {
              const first = s.refImageIds[0];
              return (
                <div key={s.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
                  <div className="flex h-32 items-center justify-center bg-zinc-900/80">
                    {first ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imgUrl(first)} alt={s.name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-xs text-zinc-600">未生成</span>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{s.name}</span>
                      {approved(s.status) ? (
                        <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-300">已锁定</span>
                      ) : (
                        <span className="rounded-full bg-amber-950/60 px-2 py-0.5 text-[10px] text-amber-300/80">草稿</span>
                      )}
                      <div className="ml-auto flex gap-1.5">
                        {!approved(s.status) && (
                          <button
                            onClick={() => void lock("scene", s.id, "APPROVED")}
                            disabled={busy || s.refImageIds.length === 0}
                            className="rounded-md border border-emerald-700/60 px-2 py-1 text-[11px] text-emerald-300 transition hover:bg-emerald-950/50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            锁定
                          </button>
                        )}
                        <button
                          onClick={() => void generate("scene", s.id)}
                          disabled={genDisabled}
                          className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {s.refImageIds.length > 0 ? "重新生成" : "生成"}
                        </button>
                      </div>
                    </div>
                    {s.mood && <p className="mt-1.5 text-[11px] text-zinc-500">氛围：{s.mood}</p>}
                    {s.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-zinc-600">{s.description}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ③ 道具 */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">③ 道具设计</h3>
            <p className="mt-0.5 text-xs text-zinc-500">添加关键道具（如戒指、车、手机），生成统一画风的设计图。</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            value={propName}
            onChange={(e) => setPropName(e.target.value)}
            placeholder="道具名称（如：祖母绿戒指）"
            className="w-48 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-sm outline-none transition focus:border-violet-500"
          />
          <input
            value={propDesc}
            onChange={(e) => setPropDesc(e.target.value)}
            placeholder="描述（可选）"
            className="w-64 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-sm outline-none transition focus:border-violet-500"
          />
          <button
            onClick={() => void generate("prop", undefined, { name: propName, desc: propDesc })}
            disabled={genDisabled || !propName.trim()}
            className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            添加并生成
          </button>
        </div>
        {data.props.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {data.props.map((p) => (
              <div key={p.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
                <div className="flex h-24 items-center justify-center bg-zinc-900/80">
                  {p.imageIds[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imgUrl(p.imageIds[0])} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs text-zinc-600">未生成</span>
                  )}
                </div>
                <div className="flex items-center gap-2 p-2.5">
                  <span className="text-sm font-medium">{p.name}</span>
                  {approved(p.status) ? (
                    <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-300">已锁定</span>
                  ) : (
                    <span className="rounded-full bg-amber-950/60 px-2 py-0.5 text-[10px] text-amber-300/80">草稿</span>
                  )}
                  <div className="ml-auto flex gap-1">
                    {!approved(p.status) && (
                      <button
                        onClick={() => void lock("prop", p.id, "APPROVED")}
                        disabled={busy || p.imageIds.length === 0}
                        className="rounded-md border border-emerald-700/60 px-1.5 py-0.5 text-[10px] text-emerald-300 disabled:opacity-40"
                      >
                        锁定
                      </button>
                    )}
                    <button
                      onClick={() => void generate("prop", p.id)}
                      disabled={genDisabled}
                      className="rounded-md bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium text-white disabled:opacity-40"
                    >
                      重生成
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-center text-xs text-zinc-600">
        当前项目：{projectTitle} · 锁定（APPROVED）的资产将作为 M3 分镜的参考图保证一致性
      </p>
    </div>
  );
}
