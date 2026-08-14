"use client";

import Link from "next/link";
import { useState } from "react";
import SettingsPanel from "@/components/web/SettingsPanel";
import PromptTemplatesPanel from "@/components/web/PromptTemplatesPanel";

type SettingsTab = "providers" | "prompts";

/**
 * 设置页：左右栏布局
 * 左栏：导航（供应商设置 / 提示词模板）
 * 右栏：对应面板（供应商设置内部亦为左右栏：分组 | 字段）
 */
export default function SettingsPageClient() {
  const [tab, setTab] = useState<SettingsTab>("providers");

  const navItem = (id: SettingsTab, label: string, desc: string) => {
    const activeTab = tab === id;
    return (
      <button
        key={id}
        onClick={() => setTab(id)}
        className={`w-full rounded-xl px-4 py-3 text-left transition ${
          activeTab
            ? "bg-violet-600/15 text-violet-200 ring-1 ring-violet-500/40"
            : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
        }`}
      >
        <span className="block text-sm font-medium">{label}</span>
        <span className={`mt-0.5 block text-[11px] ${activeTab ? "text-violet-300/70" : "text-zinc-600"}`}>
          {desc}
        </span>
      </button>
    );
  };

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      {/* 返回按钮 */}
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-zinc-300"
      >
        <span aria-hidden>←</span> 返回首页
      </Link>

      <h1 className="mb-1 text-2xl font-bold">设置</h1>
      <p className="mb-6 text-sm text-zinc-500">供应商密钥、Mock 开关、环境变量关联与全局提示词模板</p>

      {/* 左右栏布局 */}
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        {/* 左栏导航 */}
        <nav className="flex shrink-0 flex-col gap-2 md:w-56" aria-label="设置导航">
          {navItem("providers", "供应商设置", "文本 / 图片 / 视频 / TTS 引擎与密钥")}
          {navItem("prompts", "提示词模板", "内置默认 / 自定义，AI 自动配置或手动输入")}
        </nav>

        {/* 右栏内容 */}
        <div className="min-w-0 flex-1">
          {tab === "providers" ? <SettingsPanel /> : <PromptTemplatesPanel scope="global" />}
        </div>
      </div>
    </main>
  );
}
