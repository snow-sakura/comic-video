"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ========== 类型（与 /api/prompt-templates 响应一致） ==========

interface TemplateVar {
  name: string;
  desc: string;
}

interface TemplateRowInfo {
  template: string;
  enabled: boolean;
  name: string;
}

interface TemplateListItem {
  key: string;
  name: string;
  desc: string;
  variables: TemplateVar[];
  defaultTemplate: string;
  global: TemplateRowInfo | null;
  project: TemplateRowInfo | null;
  effective: string;
}

interface Props {
  /** global=设置页全局模板；project 模式传 projectId 走项目级定制 */
  scope: "global" | "project";
  projectId?: string;
  /** 项目模式可用：AI 自动配置需要项目名/剧情，展示用 */
  projectName?: string;
}

type SourceMode = "builtin" | "custom";
type InputMode = "manual" | "ai";

const STATUS_STYLE = {
  badge: "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
  on: "bg-emerald-950 text-emerald-500",
  off: "bg-zinc-800 text-zinc-500",
};

/**
 * 提示词模板面板（左右栏布局）
 * 左栏：模板列表（名称 / 来源状态）
 * 右栏：选中模板编辑区 —— 来源选择（内置默认 / 自定义）+ 自定义输入方式（手动 / AI 自动生成）
 * 解析优先级：项目定制 > 全局模板 > 内置默认
 */
export default function PromptTemplatesPanel({ scope, projectId, projectName }: Props) {
  const [templates, setTemplates] = useState<TemplateListItem[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<SourceMode>("builtin");
  const [inputMode, setInputMode] = useState<InputMode>("manual");
  const [draft, setDraft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [aiHint, setAiHint] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [aiKey, setAiKey] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState("");

  const isProject = scope === "project";
  const query = isProject && projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

  const flash = useCallback((text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 2500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/prompt-templates${query}`);
      if (!res.ok) throw new Error("加载失败");
      const j = (await res.json()) as { templates: TemplateListItem[] };
      setTemplates(j.templates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/prompt-templates${query}`);
        if (!res.ok) throw new Error("加载失败");
        const j = (await res.json()) as { templates: TemplateListItem[] };
        if (!cancelled) setTemplates(j.templates);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "网络错误");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  /** 选中一行：初始化来源模式与草稿 */
  function select(key: string) {
    const t = templates?.find((x) => x.key === key);
    if (!t) return;
    setSelectedKey(key);
    const row = isProject ? t.project : t.global;
    setMode(row ? "custom" : "builtin");
    setInputMode("manual");
    setDraft(row?.template ?? t.defaultTemplate);
    setEnabledDraft(row?.enabled ?? true);
    setAiHint("");
  }

  const selected = templates?.find((x) => x.key === selectedKey) ?? null;

  const rowStatus = useMemo(() => {
    const m = new Map<string, { source: "内置默认" | "全局模板" | "项目定制"; enabled: boolean }>();
    for (const t of templates ?? []) {
      if (isProject && t.project) m.set(t.key, { source: "项目定制", enabled: t.project.enabled });
      else if (t.global) m.set(t.key, { source: "全局模板", enabled: t.global.enabled });
      else m.set(t.key, { source: "内置默认", enabled: true });
    }
    return m;
  }, [templates, isProject]);

  /** 保存：custom → PUT 写入（自定义模板）；builtin → DELETE 重置为内置默认 */
  async function save() {
    if (!selected) return;
    if (mode === "custom" && !draft.trim()) {
      flash("模板内容不能为空", false);
      return;
    }
    setSaving(true);
    try {
      if (mode === "custom") {
        const res = await fetch("/api/prompt-templates", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: selected.key,
            scope,
            projectId: isProject ? projectId : null,
            template: draft,
            enabled: enabledDraft,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? "保存失败");
        }
        flash("已保存自定义模板 ✓");
      } else {
        const res = await fetch(
          `/api/prompt-templates?key=${selected.key}&scope=${scope}${isProject && projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
          { method: "DELETE" }
        );
        if (!res.ok) throw new Error("重置失败");
        flash("已切换为内置默认 ✓");
      }
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : "保存失败", false);
    } finally {
      setSaving(false);
    }
  }

  /** AI 自动生成：生成建议填入草稿（不直接保存，用户确认后保存） */
  async function aiGenerate() {
    if (!selected) return;
    setAiKey(true);
    setMsg(null);
    try {
      const res = await fetch("/api/prompt-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: selected.key,
          projectId: isProject ? projectId : undefined,
          currentTemplate: draft || selected.effective,
          extraHint: aiHint || undefined,
        }),
      });
      const j = (await res.json()) as { ok?: boolean; suggested?: string; error?: string };
      if (!res.ok || !j.suggested) throw new Error(j?.error ?? "AI 生成失败");
      setDraft(j.suggested ?? "");
      setInputMode("manual");
      flash("AI 已生成建议，请确认后保存 ✓");
    } catch (e) {
      flash(e instanceof Error ? e.message : "AI 生成失败", false);
    } finally {
      setAiKey(false);
    }
  }

  if (loading && !templates) {
    return <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">加载模板…</section>;
  }
  if (error && !templates) {
    return <section className="rounded-2xl border border-red-800 bg-red-950/40 p-8 text-center text-sm text-red-400">{error}</section>;
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold">提示词模板</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            {isProject
              ? `仅应用于项目「${projectName ?? "…"}」的定制模板。解析优先级：项目定制 &gt; 全局模板 &gt; 内置默认。`
              : "全局通用模板，覆盖所有小说。解析优先级：项目定制 &gt; 全局模板 &gt; 内置默认。"}
          </p>
        </div>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-500" : "text-red-400"}`}>{msg.text}</span>}
      </div>

      {/* 左右栏布局：左=模板列表，右=选中模板编辑区 */}
      <div className="mt-5 flex flex-col gap-5 md:flex-row">
        {/* 左栏：模板列表 */}
        <ul className="flex shrink-0 flex-col gap-1.5 md:w-72">
          {(templates ?? []).map((t) => {
            const st = rowStatus.get(t.key);
            const isSel = selectedKey === t.key;
            return (
              <li key={t.key}>
                <button
                  onClick={() => select(t.key)}
                  className={`w-full rounded-xl border px-3.5 py-2.5 text-left transition ${
                    isSel
                      ? "border-violet-500/50 bg-violet-600/10"
                      : "border-zinc-800 bg-zinc-950/30 hover:border-zinc-600 hover:bg-zinc-800/40"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-medium ${isSel ? "text-violet-200" : "text-zinc-200"}`}>{t.name}</span>
                    <span className={STATUS_STYLE.badge + (st?.enabled === false ? " " + STATUS_STYLE.off : " " + STATUS_STYLE.on)}>
                      {st?.source ?? "内置默认"}
                      {st?.enabled === false ? "（已禁用）" : ""}
                    </span>
                  </span>
                  <span className={`mt-0.5 block text-[11px] ${isSel ? "text-violet-300/70" : "text-zinc-600"}`}>{t.desc}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* 右栏：编辑区 */}
        <div className="min-w-0 flex-1">
          {!selected ? (
            <div className="rounded-xl border border-dashed border-zinc-700 py-16 text-center text-sm text-zinc-600">
              从左侧选择一个模板开始配置
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-700 bg-zinc-950/30 p-4">
              {/* 模板信息 */}
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-zinc-100">{selected.name}</h3>
                <code className="text-[11px] text-zinc-500">{selected.key}</code>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{selected.desc}</p>

              {/* 变量说明 */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {selected.variables.map((v) => (
                  <span key={v.name} title={v.desc} className="rounded-md bg-violet-950 px-2 py-0.5 text-[11px] text-violet-400">
                    {"{"}{v.name}{"}"}
                    <span className="ml-1 text-zinc-500">{v.desc}</span>
                  </span>
                ))}
              </div>

              {/* 来源选择：内置默认 / 自定义 */}
              <div className="mt-4 flex gap-1.5 rounded-xl bg-zinc-950/50 p-1.5" role="radiogroup" aria-label="模板来源">
                <button
                  onClick={() => {
                    setMode("builtin");
                    setDraft(selected.defaultTemplate);
                    setEnabledDraft(true);
                  }}
                  role="radio"
                  aria-checked={mode === "builtin"}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    mode === "builtin" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  内置默认
                  <span className="ml-1.5 text-[10px] text-zinc-500">开箱即用</span>
                </button>
                <button
                  onClick={() => {
                    setMode("custom");
                    const row = isProject ? selected.project : selected.global;
                    setDraft(row?.template ?? selected.effective);
                    setEnabledDraft(row?.enabled ?? true);
                  }}
                  role="radio"
                  aria-checked={mode === "custom"}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    mode === "custom" ? "bg-violet-600 text-white" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  自定义
                  <span className="ml-1.5 text-[10px] opacity-70">AI 生成或手动输入</span>
                </button>
              </div>

              {mode === "builtin" ? (
                /* 内置默认：只读预览 */
                <div className="mt-4">
                  <p className="mb-1.5 text-xs text-zinc-500">内置默认模板（只读预览）</p>
                  <textarea
                    readOnly
                    value={selected.defaultTemplate}
                    rows={9}
                    spellCheck={false}
                    className="w-full cursor-not-allowed rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 font-mono text-xs leading-relaxed text-zinc-500"
                  />
                  <p className="mt-1 text-[11px] text-zinc-600">
                    保存后本模板将恢复系统内置行为{isProject && selected.global ? "（项目未定制时继承全局模板）" : ""}。
                  </p>
                </div>
              ) : (
                /* 自定义：输入方式切换（手动 / AI 自动生成） */
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-1.5 text-xs">
                    <button
                      onClick={() => setInputMode("manual")}
                      className={`rounded-md px-2.5 py-1 transition ${inputMode === "manual" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                    >
                      手动输入
                    </button>
                    <button
                      onClick={() => setInputMode("ai")}
                      className={`rounded-md px-2.5 py-1 transition ${inputMode === "ai" ? "bg-sky-800 text-sky-100" : "text-zinc-500 hover:text-zinc-300"}`}
                    >
                      ✨ AI 自动生成
                    </button>
                  </div>

                  {inputMode === "ai" ? (
                    <div className="rounded-lg border border-sky-900/60 bg-sky-950/20 p-3">
                      <p className="mb-2 text-xs text-zinc-400">
                        AI 将结合当前模板用途、变量说明{isProject ? "与项目剧情" : ""}生成建议，生成后仍可手动修改再保存。
                      </p>
                      <input
                        value={aiHint}
                        onChange={(e) => setAiHint(e.target.value)}
                        placeholder="AI 附加要求（可选）：如「多强调宿命感」「台词更文雅」…"
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-sky-500"
                      />
                      <button
                        onClick={() => void aiGenerate()}
                        disabled={aiKey}
                        className="mt-2 rounded-lg bg-sky-300 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-sky-400 disabled:opacity-40"
                      >
                        {aiKey ? "AI 生成中…" : "✨ 生成模板建议"}
                      </button>
                    </div>
                  ) : (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={9}
                      spellCheck={false}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 p-3 font-mono text-xs leading-relaxed text-zinc-300 outline-none transition focus:border-violet-500"
                    />
                  )}
                </div>
              )}

              {/* 操作条 */}
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={enabledDraft}
                    disabled={mode === "builtin"}
                    onChange={(e) => setEnabledDraft(e.target.checked)}
                    className="accent-violet-600"
                  />
                  启用此模板
                </label>
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
                >
                  {saving ? "保存中…" : mode === "builtin" ? "保存（恢复内置默认）" : "保存自定义模板"}
                </button>
                {isProject && selected.global && (
                  <span className="text-[11px] text-zinc-600">未定制时继承全局模板</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
