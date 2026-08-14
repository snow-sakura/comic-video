"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";
import ScriptWorkbench from "@/components/mobile/script/ScriptWorkbench";
import AssetWorkbench from "@/components/mobile/asset/AssetWorkbench";
import StoryboardWorkbench from "@/components/mobile/storyboard/StoryboardWorkbench";
import ComposeWorkbench from "@/components/mobile/compose/ComposeWorkbench";

interface Project {
  id: string;
  title: string;
  status: string;
  novelText: string | null;
  createdAt: string;
  scripts: { id: string; logline: string | null; status: string; version: number }[];
  characters: { id: string; name: string }[];
  scenes: { id: string; name: string }[];
  episodes: { id: string; title: string; number: number }[];
  tasks: {
    id: string;
    label: string;
    status: string;
    cost: number | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

const STEPS = [
  { key: "script", num: "01", name: "剧本" },
  { key: "asset", num: "02", name: "资产" },
  { key: "storyboard", num: "03", name: "分镜" },
  { key: "compose", num: "04", name: "合成" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

const SUB_STEPS: Record<StepKey, { id: string; name: string }[]> = {
  script: [
    { id: "script-upload", name: "上传小说" },
    { id: "script-character", name: "提炼角色" },
    { id: "script-outline", name: "分集大纲" },
    { id: "script-scripts", name: "分集剧本" },
  ],
  asset: [
    { id: "asset-character", name: "角色定妆照" },
    { id: "asset-scene", name: "场景空镜" },
    { id: "asset-prop", name: "道具设计" },
  ],
  storyboard: [
    { id: "storyboard-episode", name: "选择剧集" },
    { id: "storyboard-shots", name: "分镜·出图" },
  ],
  compose: [
    { id: "compose-episode", name: "选择剧集" },
    { id: "compose-preview", name: "成片预览" },
    { id: "compose-shots", name: "镜头·配音" },
  ],
};

export default function MobileWorkbenchPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<StepKey>("script");
  const [sub, setSub] = useState<string>(SUB_STEPS.script[0].id);

  // 从 URL 读取初始 step/sub（避免 useSearchParams 的 Suspense 限制）
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const s = sp.get("step") as StepKey | null;
    const sb = sp.get("sub");
    if (s && STEPS.some((x) => x.key === s)) {
      setStep(s);
      setSub(sb ?? SUB_STEPS[s][0].id);
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (res.ok) setProject(await res.json());
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const t = setTimeout(() => void loadProject(), 0);
    return () => clearTimeout(t);
  }, [loadProject]);

  // 切换步骤时同步 URL（方便分享与返回定位）
  const switchStep = (key: StepKey) => {
    setStep(key);
    const firstSub = SUB_STEPS[key][0].id;
    setSub(firstSub);
    const url = new URL(window.location.href);
    url.searchParams.set("step", key);
    url.searchParams.set("sub", firstSub);
    router.replace(`${url.pathname}?${url.searchParams.toString()}`);
  };

  const switchSub = (s: string) => {
    setSub(s);
    const url = new URL(window.location.href);
    url.searchParams.set("step", step);
    url.searchParams.set("sub", s);
    router.replace(`${url.pathname}?${url.searchParams.toString()}`);
  };

  if (loading) {
    return (
      <main className="px-4 py-6">
        <WorkbenchSkeleton />
      </main>
    );
  }
  if (!project) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
        <p className="text-zinc-400">项目不存在</p>
        <Link href="/m" className="text-sm text-violet-400 hover:underline">
          返回首页
        </Link>
      </main>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <main className="px-4 py-4">
      {/* 头部：返回 + 标题 + 状态 + 设置入口 */}
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <Link
            href="/m"
            className="flex shrink-0 items-center rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400"
          >
            ←
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-base font-bold">{project.title}</h1>
              <span className="shrink-0 rounded-full bg-emerald-950 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                {project.status === "COMPLETED" ? "已完成" : "制作中"}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-zinc-500">
              {new Date(project.createdAt).toLocaleDateString("zh-CN")}
              {project.novelText ? " · 已导入小说" : ""}
            </p>
          </div>
          <Link
            href="/m/settings"
            className="flex shrink-0 items-center rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400"
          >
            ⚙
          </Link>
        </div>

        {/* 整体进度条 */}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-violet-600 transition-all duration-300"
            style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </header>

      {/* 4 步横向步骤条（紧凑） */}
      <div className="mb-3 flex items-center gap-1.5">
        {STEPS.map((s, i) => {
          const active = step === s.key;
          const done = i < stepIndex;
          return (
            <button
              key={s.key}
              onClick={() => switchStep(s.key)}
              className={`flex flex-1 flex-col items-center gap-1 rounded-lg border py-2 transition ${
                active
                  ? "border-violet-600 bg-violet-600 text-white"
                  : "border-zinc-800 bg-zinc-900/40 text-zinc-400"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                  active ? "bg-white/20 text-white" : done ? "bg-emerald-950 text-emerald-500" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {done ? "✓" : s.num}
              </span>
              <span className="text-[10px] font-medium">{s.name}</span>
            </button>
          );
        })}
      </div>

      {/* 子步骤横向滚动 chips */}
      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {SUB_STEPS[step].map((s) => {
          const active = sub === s.id;
          return (
            <button
              key={s.id}
              onClick={() => switchSub(s.id)}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition ${
                active
                  ? "border-violet-600 bg-violet-600 text-white"
                  : "border-zinc-700 bg-zinc-900/40 text-zinc-400"
              }`}
            >
              {s.name}
            </button>
          );
        })}
      </div>

      {/* 工作台内容 */}
      <section className="animate-in">
        <StepContent step={step} sub={sub} project={project} />
      </section>

      {/* 前后步骤 */}
      <div className="mt-5 flex items-center justify-between">
        <button
          onClick={() => {
            const prev = STEPS[Math.max(0, stepIndex - 1)];
            if (prev.key !== step) switchStep(prev.key);
          }}
          disabled={stepIndex === 0}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-400 disabled:opacity-40"
        >
          ← 上一步
        </button>
        <span className="text-[10px] text-zinc-500">
          {stepIndex + 1}/{STEPS.length}
        </span>
        <button
          onClick={() => {
            const next = STEPS[Math.min(STEPS.length - 1, stepIndex + 1)];
            if (next.key !== step) switchStep(next.key);
          }}
          disabled={stepIndex === STEPS.length - 1}
          className="rounded-lg bg-violet-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
        >
          下一步 →
        </button>
      </div>

      {/* 任务入口 */}
      <Link
        href="/m/tasks"
        className="mt-4 block rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2.5 text-center text-xs text-zinc-400"
      >
        查看任务中心 →
      </Link>
    </main>
  );
}

function StepContent({
  step,
  sub,
  project,
}: {
  step: StepKey;
  sub: string;
  project: Project;
}) {
  if (step === "script") {
    return <ScriptWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }
  if (step === "asset") {
    return <AssetWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }
  if (step === "storyboard") {
    return <StoryboardWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }
  if (step === "compose") {
    return <ComposeWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }
  return null;
}
