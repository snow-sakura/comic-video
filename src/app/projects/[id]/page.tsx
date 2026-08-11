"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import SettingsPanel from "@/components/SettingsPanel";
import ScriptWorkbench from "@/components/script/ScriptWorkbench";
import AssetWorkbench from "@/components/asset/AssetWorkbench";
import StoryboardWorkbench from "@/components/storyboard/StoryboardWorkbench";
import ComposeWorkbench from "@/components/compose/ComposeWorkbench";
import TaskCostPanel from "@/components/TaskCostPanel";

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

// ========== 组件 ==========

export default function WorkbenchPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<StepKey>("script");
  const [showSettings, setShowSettings] = useState(false);
  const [showTasks, setShowTasks] = useState(false);

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

  if (loading) {
    return <main className="flex flex-1 items-center justify-center text-sm text-zinc-500">加载中…</main>;
  }
  if (!project) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-zinc-400">项目不存在</p>
        <Link href="/" className="text-sm text-violet-400 hover:underline">返回首页</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-8">
      {/* 头部 */}
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-zinc-500 transition hover:text-zinc-300">← 返回</Link>
          <div>
            <h1 className="text-xl font-bold">{project.title}</h1>
            <p className="text-xs text-zinc-500">
              创建于 {new Date(project.createdAt).toLocaleDateString("zh-CN")}
              {project.novelText ? " · 已导入小说" : ""}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            showSettings
              ? "border-violet-500 bg-violet-500/10 text-violet-300"
              : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
          }`}
        >
          设置
        </button>
      </header>

      {showSettings ? (
        <SettingsPanel onSaved={() => void loadProject()} />
      ) : (
        <>
          {/* 任务与费用面板（可折叠，避免与步骤内容堆叠） */}
          <div className="mb-5">
            <button
              onClick={() => setShowTasks((v) => !v)}
              className="flex w-full items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/40 px-5 py-3 text-left transition hover:border-zinc-600"
            >
              <span className="text-sm font-semibold text-zinc-200">任务与费用</span>
              <span className="text-xs text-zinc-500">{showTasks ? "收起 ▲" : "展开 ▼"}</span>
            </button>
            {showTasks && <div className="mt-2"><TaskCostPanel tasks={project.tasks} /></div>}
          </div>

          {/* 步骤 TAB 条（横向，01→04 前后流程） */}
          <nav className="mb-6 flex flex-wrap items-stretch gap-1 rounded-xl border border-zinc-800 bg-zinc-900/40 p-1.5">
            {STEPS.map((s, i) => {
              const active = step === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setStep(s.key)}
                  className={`flex flex-1 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition ${
                    active
                      ? "bg-violet-600 text-white shadow-sm"
                      : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                  }`}
                >
                  <span
                    className={`font-mono text-[11px] ${
                      active ? "text-white/70" : "text-zinc-600"
                    }`}
                  >
                    {s.num}
                  </span>
                  <span className="flex flex-col">
                    <span className="text-sm font-semibold leading-tight">{s.name}</span>
                    <span
                      className={`text-[11px] leading-tight ${
                        active ? "text-white/70" : "text-zinc-600"
                      }`}
                    >
                      {s.desc}
                    </span>
                  </span>
                  {i < STEPS.length - 1 && (
                    <span className={`ml-auto hidden text-zinc-600 sm:block ${active ? "text-white/50" : ""}`}>
                      →
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* 步骤内容 */}
          <StepContent step={step} project={project} onRefresh={() => void loadProject()} />

          {/* 前后步骤引导 */}
          <div className="mt-5 flex items-center justify-between">
            <button
              onClick={() => setStep(STEPS[Math.max(0, STEPS.findIndex((s) => s.key === step) - 1)].key)}
              disabled={step === STEPS[0].key}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← 上一步
            </button>
            <span className="text-xs text-zinc-600">
              {STEPS.findIndex((s) => s.key === step) + 1} / {STEPS.length}
            </span>
            <button
              onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, STEPS.findIndex((s) => s.key === step) + 1)].key)}
              disabled={step === STEPS[STEPS.length - 1].key}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一步 →
            </button>
          </div>
        </>
      )}
    </main>
  );
}

// ========== 步骤内容（M2-M4 填充实现，当前为骨架） ==========

function StepContent({ step, project, onRefresh }: { step: StepKey; project: Project; onRefresh: () => void }) {
  // M1：剧本工坊完整实现
  if (step === "script") {
    return <ScriptWorkbench projectId={project.id} projectTitle={project.title} />;
  }
  // M2：资产工厂完整实现
  if (step === "asset") {
    return <AssetWorkbench projectId={project.id} projectTitle={project.title} />;
  }
  // M3：分镜车间完整实现
  if (step === "storyboard") {
    return <StoryboardWorkbench projectId={project.id} projectTitle={project.title} />;
  }
  // M4：视频合成厂完整实现
  if (step === "compose") {
    return <ComposeWorkbench projectId={project.id} projectTitle={project.title} />;
  }

  const stats = {
    asset: [
      { label: "角色", value: String(project.characters.length) },
      { label: "场景", value: String(project.scenes.length) },
    ],
    storyboard: [{ label: "集数", value: String(project.episodes.length) }],
  }[step as "asset" | "storyboard"];

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold">{STEPS.find((s) => s.key === step)?.name}</h2>
          <p className="mt-1 max-w-xl text-sm text-zinc-400">
            该步骤将在后续里程碑中实现。当前里程碑已完成：基础设施（数据库 / AI 供应商适配 / 任务队列）。
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-500"
        >
          刷新
        </button>
      </div>

      <div className="mt-6 flex gap-6">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-4">
            <div className="text-2xl font-bold text-violet-300">{s.value}</div>
            <div className="mt-1 text-xs text-zinc-500">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-600">
        {step === "compose" && "M4：分镜转视频（可灵）→ 画质 QC → TTS 配音 → 音效/BGM → ffmpeg 合成导出"}
      </div>
    </section>
  );
}
