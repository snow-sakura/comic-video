"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { WorkbenchSkeleton } from "@/components/shared/Skeleton";
import SettingsPanel from "@/components/web/SettingsPanel";
import PromptTemplatesPanel from "@/components/web/PromptTemplatesPanel";
import ScriptWorkbench from "@/components/web/script/ScriptWorkbench";
import AssetWorkbench from "@/components/web/asset/AssetWorkbench";
import StoryboardWorkbench from "@/components/web/storyboard/StoryboardWorkbench";
import ComposeWorkbench from "@/components/web/compose/ComposeWorkbench";
import TaskCostPanel from "@/components/web/TaskCostPanel";

// ========== 类型 ==========

interface Project {
  id: string;
  title: string;
  status: string;
  novelText: string | null;
  createdAt: string;
  updatedAt: string;
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
  { key: "script", num: "01", name: "剧本工坊", desc: "上传小说 → 提炼人设 → 生成分集剧本" },
  { key: "asset", num: "02", name: "资产工厂", desc: "角色 / 场景 / 道具设计稿 + 一致性锁定" },
  { key: "storyboard", num: "03", name: "分镜车间", desc: "AI 分镜 → 7 维提示词 → 批量出图" },
  { key: "compose", num: "04", name: "视频合成厂", desc: "微动态 / TTS 配音 / 音效 BGM / 合成导出" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

/** 每个大步骤拆出的小步骤（对应右栏各 Workbench 的 section 锚点 id） */
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
    { id: "storyboard-shots", name: "分镜 · 出图" },
  ],
  compose: [
    { id: "compose-episode", name: "选择剧集" },
    { id: "compose-preview", name: "成片预览" },
    { id: "compose-shots", name: "镜头 · 配音" },
  ],
};

type Panel = "settings" | "prompts" | "tasks" | null;

// ========== 组件 ==========

export default function WorkbenchPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<StepKey>("script");
  const [sub, setSub] = useState<string>(SUB_STEPS.script[0].id);
  const [panel, setPanel] = useState<Panel>(null);

  // 从 URL 读取初始 step/sub（首页子步骤跳转 ?step=&sub= 锚点；避免 useSearchParams 的 Suspense 限制）
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

  // 切换大步骤时，小步骤重置为该步骤的第一个，并同步 URL（方便分享与返回定位）
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
    return <main className="flex flex-1 items-center justify-center"><WorkbenchSkeleton /></main>;
  }
  if (!project) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-zinc-400">项目不存在</p>
        <Link href="/" className="text-sm text-violet-400 hover:underline">返回首页</Link>
      </main>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 py-8">
      {/* 头部：返回 + 标题 + 状态 + 操作按钮 */}
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-500 transition hover:border-zinc-500 hover:text-zinc-300"
            >
              ← 返回
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-2xl font-bold">{project.title}</h1>
                <span className="shrink-0 rounded-full bg-emerald-950 px-2.5 py-0.5 text-[11px] font-medium text-emerald-500">
                  {project.status === "COMPLETED" ? "已完成" : "制作中"}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">
                创建于 {new Date(project.createdAt).toLocaleDateString("zh-CN")}
                {project.novelText ? " · 已导入小说" : ""}
              </p>
            </div>
          </div>
          {/* 操作按钮组 */}
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => setPanel((p) => (p === "tasks" ? null : "tasks"))}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                panel === "tasks"
                  ? "border-violet-500 bg-violet-500/10 text-violet-300"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              }`}
            >
              任务与费用
            </button>
            <button
              onClick={() => setPanel((p) => (p === "prompts" ? null : "prompts"))}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                panel === "prompts"
                  ? "border-violet-500 bg-violet-500/10 text-violet-300"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              }`}
            >
              提示词
            </button>
            <button
              onClick={() => setPanel((p) => (p === "settings" ? null : "settings"))}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                panel === "settings"
                  ? "border-violet-500 bg-violet-500/10 text-violet-300"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              }`}
            >
              设置
            </button>
          </div>
        </div>

        {/* 整体进度条 */}
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-violet-600 transition-all duration-300"
            style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </header>

      {panel ? (
        <div className="space-y-4">
          {panel === "tasks" && <TaskCostPanel projectId={project.id} />}
          {panel === "prompts" && (
            <PromptTemplatesPanel scope="project" projectId={project.id} projectName={project.title} />
          )}
          {panel === "settings" && <SettingsPanel onSaved={() => void loadProject()} />}
          <button
            onClick={() => setPanel(null)}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
          >
            ← 返回步骤 {STEPS[stepIndex].name}
          </button>
        </div>
      ) : (
        /* 三栏布局：左=大步骤导航 / 中=小步骤 / 右=工作台内容 */
        <div className="grid gap-5 lg:grid-cols-[200px_180px_minmax(0,1fr)]">
          {/* ===== 左栏：4 大步骤 ===== */}
          <aside className="flex flex-col gap-2">
            <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-600">制作流程</p>
            {STEPS.map((s, i) => {
              const active = step === s.key;
              const done = i < stepIndex;
              return (
                <button
                  key={s.key}
                  onClick={() => {
                    switchStep(s.key);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  aria-current={active ? "step" : undefined}
                  className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition ${
                    active
                      ? "border-violet-600 bg-violet-600 text-white shadow-lg shadow-violet-600/20"
                      : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-600 hover:bg-zinc-900/70"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                      active
                        ? "bg-white/20 text-white"
                        : done
                          ? "bg-emerald-950 text-emerald-500"
                          : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {done ? "✓" : s.num}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-semibold leading-tight ${active ? "text-white" : "text-zinc-200"}`}>
                      {s.name}
                    </span>
                    <span className={`mt-0.5 block truncate text-[11px] leading-relaxed ${active ? "text-white/75" : "text-zinc-500"}`}>
                      {s.desc}
                    </span>
                  </span>
                </button>
              );
            })}
          </aside>

          {/* ===== 中栏：当前步骤的小步骤（点击 → 第三栏只显示对应内容） ===== */}
          <aside className="flex flex-col gap-1.5">
            <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              小步骤 · {STEPS[stepIndex].name}
            </p>
            {SUB_STEPS[step].map((s) => {
              const active = sub === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => switchSub(s.id)}
                  aria-current={active ? "step" : undefined}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                    active
                      ? "border-violet-600 bg-violet-600 text-white shadow-lg shadow-violet-600/20"
                      : "border-zinc-800/70 bg-zinc-950/40 text-zinc-400 hover:border-violet-600/50 hover:bg-violet-600/5 hover:text-violet-200"
                  }`}
                >
                  <span
                    className={`h-1 w-1 shrink-0 rounded-full transition ${
                      active ? "bg-white" : "bg-zinc-600"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap">{s.name}</span>
                </button>
              );
            })}
          </aside>

          {/* ===== 右栏：当前小步骤内容（由中栏切换，单独显示不堆叠） ===== */}
          <section className="min-w-0 space-y-5 animate-in fade-in duration-200">
            <StepContent step={step} sub={sub} project={project} />

            {/* 前后步骤引导 */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => {
                  const prev = STEPS[Math.max(0, stepIndex - 1)];
                  if (prev.key !== step) switchStep(prev.key);
                }}
                disabled={stepIndex === 0}
                className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ← 上一步
              </button>
              <span className="text-xs font-medium text-zinc-500">
                步骤 {stepIndex + 1} / {STEPS.length}
              </span>
              <button
                onClick={() => {
                  const next = STEPS[Math.min(STEPS.length - 1, stepIndex + 1)];
                  if (next.key !== step) switchStep(next.key);
                }}
                disabled={stepIndex === STEPS.length - 1}
                className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一步 →
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

// ========== 步骤内容 ==========

function StepContent({
  step,
  sub,
  project,
}: {
  step: StepKey;
  /** 中栏选中的小步骤 id（第三栏只显示对应内容，不一次性全部展示） */
  sub: string;
  project: Project;
}) {
  // M1：剧本工坊完整实现
  if (step === "script") {
    return <ScriptWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }
  // M2：资产工厂完整实现
  if (step === "asset") {
    return <AssetWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }
  // M3：分镜车间完整实现
  if (step === "storyboard") {
    return <StoryboardWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }
  // M4：视频合成厂完整实现
  if (step === "compose") {
    return <ComposeWorkbench projectId={project.id} projectTitle={project.title} sub={sub} />;
  }

  // 四个步骤均已完整实现，理论不可达；保留兜底避免未来新增步骤时空白
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
      <h2 className="text-lg font-bold">{STEPS.find((s) => s.key === step)?.name}</h2>
      <p className="mt-1 text-sm text-zinc-400">该步骤暂未实现。</p>
    </section>
  );
}
