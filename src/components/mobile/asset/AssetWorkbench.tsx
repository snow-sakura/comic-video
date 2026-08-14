"use client";

/**
 * 移动端 · 资产工厂工作台
 * 角色定妆照 / 场景空镜 / 道具设计稿生成 + 一致性锁定
 * 复用 web 端相同 API（/assets），UI 针对移动端单列触控优化。
 */
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/lib/hooks/use-polling";
import { useAutoError } from "@/lib/hooks/use-auto-error";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";

interface AssetCharacter {
  id: string;
  name: string;
  role: string;
  status: string;
  refImageIds: string[];
  appearance: Record<string, string>;
  voiceName: string | null;
  voiceId: string | null;
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

export default function AssetWorkbench({
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
  const [busy, setBusy] = useState(false);
  const [propName, setPropName] = useState("");
  const [propDesc, setPropDesc] = useState("");

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
  }, [projectId, setError]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  usePolling(load, Boolean(data?.runningTask));

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

  const lock = useCallback(
    async (kind: string, refId: string, status: string) => {
      setBusy(true);
      setError(null);
      setData((prev) => {
        if (!prev) return prev;
        const updateStatus = (items: { id: string; status: string }[]) =>
          items.map((item) => (item.id === refId ? { ...item, status } : item));
        return {
          ...prev,
          characters: kind === "character" ? (updateStatus(prev.characters) as typeof prev.characters) : prev.characters,
          scenes: kind === "scene" ? (updateStatus(prev.scenes) as typeof prev.scenes) : prev.scenes,
          props: kind === "prop" ? (updateStatus(prev.props) as typeof prev.props) : prev.props,
        };
      });
      try {
        const res = await fetch(`/api/projects/${projectId}/assets`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, refId, status }),
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

  if (loading) return <WorkbenchSkeleton />;

  const show = (id: string) => !sub || sub === id;
  const rt = data?.runningTask;
  const running = rt && (rt.status === "QUEUED" || rt.status === "PROCESSING");

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

      {/* 角色定妆照 */}
      {show("asset-character") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold">角色定妆照</h3>
          {data && data.characters.length > 0 ? (
            <ul className="space-y-2.5">
              {data.characters.map((c) => {
                const imgPath = c.refImageIds[0];
                const locked = c.status === "APPROVED";
                return (
                  <li key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                    <div className="flex gap-2.5">
                      {imgPath ? (
                        <img
                          src={imgUrl(imgPath)}
                          alt={c.name}
                          className="h-16 w-16 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-[10px] text-zinc-600">
                          无图
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{c.name}</span>
                          <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                            {ROLE_LABEL[c.role] ?? c.role}
                          </span>
                          {locked && <span className="shrink-0 text-[10px] text-emerald-400">🔒 锁定</span>}
                        </div>
                        <div className="mt-1.5 flex gap-1.5">
                          <button
                            onClick={() => void generate("character", c.id)}
                            disabled={busy || locked}
                            className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                          >
                            {imgPath ? "重生成" : "生成定妆照"}
                          </button>
                          <button
                            onClick={() => void lock("character", c.id, locked ? "DRAFT" : "APPROVED")}
                            disabled={busy || !imgPath}
                            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 disabled:opacity-40"
                          >
                            {locked ? "解锁" : "锁定"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">请先在剧本工坊提炼角色</p>
          )}
        </section>
      )}

      {/* 场景空镜 */}
      {show("asset-scene") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold">场景空镜</h3>
          {data && data.scenes.length > 0 ? (
            <ul className="space-y-2.5">
              {data.scenes.map((s) => {
                const imgPath = s.refImageIds[0];
                const locked = s.status === "APPROVED";
                return (
                  <li key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                    <div className="flex gap-2.5">
                      {imgPath ? (
                        <img src={imgUrl(imgPath)} alt={s.name} className="h-16 w-16 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-[10px] text-zinc-600">无图</div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{s.name}</span>
                          {locked && <span className="text-[10px] text-emerald-400">🔒</span>}
                        </div>
                        {s.mood && <p className="mt-0.5 text-[11px] text-zinc-500">{s.mood}</p>}
                        <div className="mt-1.5 flex gap-1.5">
                          <button
                            onClick={() => void generate("scene", s.id)}
                            disabled={busy || locked}
                            className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                          >
                            {imgPath ? "重生成" : "生成空镜"}
                          </button>
                          <button
                            onClick={() => void lock("scene", s.id, locked ? "DRAFT" : "APPROVED")}
                            disabled={busy || !imgPath}
                            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 disabled:opacity-40"
                          >
                            {locked ? "解锁" : "锁定"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">暂无场景（剧本生成后自动产生）</p>
          )}
        </section>
      )}

      {/* 道具设计 */}
      {show("asset-prop") && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold">道具设计</h3>
          <div className="mb-3 rounded-lg bg-zinc-950/40 p-2.5">
            <input
              value={propName}
              onChange={(e) => setPropName(e.target.value)}
              placeholder="道具名称"
              className="mb-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-500 focus:border-violet-500"
            />
            <input
              value={propDesc}
              onChange={(e) => setPropDesc(e.target.value)}
              placeholder="道具描述（可选）"
              className="mb-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-500 focus:border-violet-500"
            />
            <button
              onClick={() => {
                if (!propName.trim()) return;
                void generate("prop", undefined, { name: propName.trim(), description: propDesc.trim() });
                setPropName("");
                setPropDesc("");
              }}
              disabled={busy || !propName.trim()}
              className="w-full rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              添加并生成道具
            </button>
          </div>
          {data && data.props.length > 0 ? (
            <ul className="space-y-2">
              {data.props.map((p) => {
                const imgPath = p.imageIds[0];
                const locked = p.status === "APPROVED";
                return (
                  <li key={p.id} className="flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
                    {imgPath ? (
                      <img src={imgUrl(imgPath)} alt={p.name} className="h-12 w-12 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] text-zinc-600">
                        {p.status === "PROCESSING" ? "…" : "无"}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium">{p.name}</span>
                        {locked && <span className="text-[10px] text-emerald-400">🔒</span>}
                      </div>
                      <div className="mt-1 flex gap-1.5">
                        <button
                          onClick={() => void generate("prop", p.id)}
                          disabled={busy || locked}
                          className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] text-white disabled:opacity-40"
                        >
                          重生成
                        </button>
                        <button
                          onClick={() => void lock("prop", p.id, locked ? "DRAFT" : "APPROVED")}
                          disabled={busy || !imgPath}
                          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 disabled:opacity-40"
                        >
                          {locked ? "解锁" : "锁定"}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">暂无道具</p>
          )}
        </section>
      )}
    </div>
  );
}
