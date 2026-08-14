"use client";

/**
 * 移动端 · 设置页
 * 顶部 TAB 切换（供应商设置 / 提示词模板），复用 web 端 SettingsPanel 与 PromptTemplatesPanel。
 * 复杂供应商配置建议在桌面端操作，移动端支持查看与紧急修改。
 */
import { useState } from "react";
import Link from "next/link";
import SettingsPanel from "@/components/web/SettingsPanel";
import PromptTemplatesPanel from "@/components/web/PromptTemplatesPanel";

type SettingsTab = "providers" | "prompts";

export default function MobileSettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("providers");

  return (
    <main className="px-4 py-4">
      <header className="mb-4">
        <Link href="/m" className="text-xs text-zinc-500">
          ← 返回
        </Link>
        <h1 className="mt-1 text-lg font-bold">设置</h1>
        <p className="mt-0.5 text-[11px] text-zinc-500">供应商密钥、Mock 开关、提示词模板</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/?device=desktop"
          className="mt-1 inline-block text-[11px] text-zinc-500 underline-offset-2 hover:underline"
        >
          切换到桌面版 →
        </a>
      </header>

      {/* 顶部 TAB 切换 */}
      <div className="mb-4 flex gap-1.5">
        <button
          onClick={() => setTab("providers")}
          className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
            tab === "providers"
              ? "border-violet-600 bg-violet-600 text-white"
              : "border-zinc-700 bg-zinc-900/40 text-zinc-400"
          }`}
        >
          供应商设置
        </button>
        <button
          onClick={() => setTab("prompts")}
          className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
            tab === "prompts"
              ? "border-violet-600 bg-violet-600 text-white"
              : "border-zinc-700 bg-zinc-900/40 text-zinc-400"
          }`}
        >
          提示词模板
        </button>
      </div>

      {/* 面板内容 */}
      <div className="min-w-0">
        {tab === "providers" ? <SettingsPanel /> : <PromptTemplatesPanel scope="global" />}
      </div>
    </main>
  );
}
