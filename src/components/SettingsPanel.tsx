"use client";

import { useEffect, useState } from "react";

// ========== 设置表单 schema ==========

interface SettingField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  options?: string[];
  hint?: string;
}

export const SETTING_FIELDS: SettingField[] = [
  { key: "mock.mode", label: "Mock 模式", type: "select", options: ["auto", "true", "false"], hint: "auto=有 Key 用真、无 Key 自动演示" },
  { key: "llm.scriptProvider", label: "剧本创作 LLM", type: "select", options: ["deepseek", "doubao"] },
  { key: "llm.structProvider", label: "结构化任务 LLM", type: "select", options: ["doubao", "deepseek"] },
  { key: "deepseek.apiKey", label: "DeepSeek API Key", type: "password", hint: "platform.deepseek.com" },
  { key: "doubao.apiKey", label: "火山方舟 API Key", type: "password", hint: "ark.cn-beijing.volces.com（豆包/Seedream 共用）" },
  { key: "image.provider", label: "图像引擎", type: "select", options: ["seedream"] },
  { key: "video.provider", label: "视频引擎", type: "select", options: ["kling"] },
  { key: "kling.apiKey", label: "可灵 AccessKey", type: "password", hint: "api.klingai.com" },
  { key: "kling.secret", label: "可灵 SecretKey", type: "password" },
  { key: "tts.provider", label: "TTS 引擎", type: "select", options: ["cosyvoice"] },
  { key: "dashscope.apiKey", label: "阿里百炼 API Key", type: "password", hint: "dashscope.aliyuncs.com（CosyVoice）" },
];

// ========== 组件 ==========

export default function SettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const j = (await res.json()) as { settings: Record<string, string> };
        setValues(j.settings);
        setLoaded(true);
      }
    })();
  }, []);

  function setValue(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    setDirty((prev) => new Set(prev).add(key));
  }

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const changes: Record<string, string> = {};
      for (const key of dirty) changes[key] = values[key] ?? "";
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: changes }),
      });
      if (res.ok) {
        setDirty(new Set());
        setMsg("已保存 ✓");
        onSaved?.();
      } else {
        setMsg("保存失败");
      }
    } catch {
      setMsg("网络错误");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <section className="rounded-2xl border border-zinc-800 p-8 text-center text-sm text-zinc-500">加载设置…</section>;
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
      <h2 className="text-lg font-bold">供应商设置</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Key 仅保存在本地数据库。未修改的字段不会提交（避免覆盖脱敏值）。
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {SETTING_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-sm font-medium">{f.label}</span>
              <code className="text-[10px] text-zinc-600">{f.key}</code>
            </div>
            {f.type === "select" ? (
              <select
                value={values[f.key] ?? ""}
                onChange={(e) => setValue(f.key, e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-500"
              >
                {f.options?.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                type={f.type}
                value={values[f.key] ?? ""}
                onChange={(e) => setValue(f.key, e.target.value)}
                placeholder={dirty.has(f.key) ? "" : "未设置（留空使用 Mock）"}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none transition placeholder:text-zinc-600 focus:border-zinc-500"
              />
            )}
            {f.hint && <p className="mt-1 text-[11px] text-zinc-600">{f.hint}</p>}
          </label>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button
          onClick={() => void save()}
          disabled={saving || dirty.size === 0}
          className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "保存中…" : dirty.size > 0 ? `保存 ${dirty.size} 项变更` : "保存"}
        </button>
        {msg && <span className="text-sm text-zinc-400">{msg}</span>}
      </div>
    </section>
  );
}
