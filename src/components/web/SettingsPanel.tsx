"use client";

import { useEffect, useMemo, useState } from "react";

// ========== 设置表单 schema（按能力分组） ==========

interface SettingField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  options?: string[];
  hint?: string;
}

interface SettingGroup {
  id: string;
  name: string;
  desc: string;
  fields: SettingField[];
}

/** 全局字段（不分组的平铺索引，供 SETTING_GROUPS 复用） */
const FIELD = {
  mockMode: { key: "mock.mode", label: "Mock 模式", type: "select", options: ["auto", "true", "false"], hint: "auto=有 Key 用真、无 Key 自动演示" } as SettingField,
  // 文本（LLM）
  textProvider: { key: "text.provider", label: "文本引擎", type: "select", options: ["glm", "deepseek", "doubao", "openai"], hint: "glm=智谱清言(默认) | deepseek | doubao=火山方舟 | openai=通用兼容(如 OpenCode Zen)" } as SettingField,
  textApiKey: { key: "text.apiKey", label: "文本 API Key", type: "password", hint: "对应 .env 的 TEXT_API_KEY" } as SettingField,
  textModel: { key: "text.model", label: "文本模型", type: "text", hint: "如 glm-4.7-flash / deepseek-v4-flash-free" } as SettingField,
  // 图像
  imageProvider: { key: "image.provider", label: "图像引擎", type: "select", options: ["cogview", "seedream", "agnes"], hint: "cogview=智谱(默认) | seedream=火山方舟 | agnes=Agnes AI" } as SettingField,
  imageApiKey: { key: "image.apiKey", label: "图像 API Key", type: "password", hint: "对应 .env 的 IMAGE_API_KEY" } as SettingField,
  imageModel: { key: "image.model", label: "图像模型", type: "text", hint: "如 cogview-3-flash / agnes-image-2.0-flash" } as SettingField,
  // 视频
  videoProvider: { key: "video.provider", label: "视频引擎", type: "select", options: ["cogvideox", "kling", "agnes"], hint: "cogvideox=智谱(默认) | kling=可灵 | agnes=Agnes AI(限流1次/分钟)" } as SettingField,
  videoApiKey: { key: "video.apiKey", label: "视频 API Key", type: "password", hint: "对应 .env 的 VIDEO_API_KEY；可灵即 AccessKey" } as SettingField,
  videoSecret: { key: "video.secret", label: "视频 Secret", type: "password", hint: "仅可灵需要（VIDEO_SECRET）" } as SettingField,
  videoModel: { key: "video.model", label: "视频模型", type: "text", hint: "如 cogvideox-flash / agnes-video-v2.0" } as SettingField,
  // 音频（TTS）
  ttsEngine: { key: "tts.engine", label: "TTS 引擎", type: "select", options: ["", "edge-tts", "cosyvoice"], hint: "留空=Mock | edge-tts=微软免费(无Key) | cosyvoice=阿里百炼" } as SettingField,
  ttsApiKey: { key: "tts.apiKey", label: "TTS API Key", type: "password", hint: "仅 cosyvoice 需要（TTS_API_KEY）" } as SettingField,
  ttsModel: { key: "tts.model", label: "TTS 模型", type: "text", hint: "如 cosyvoice-v2（edge-tts 无需）" } as SettingField,
  ttsVoice: { key: "tts.voice", label: "TTS 默认音色", type: "text", hint: "如 zh-CN-YunxiNeural / longxiaochun_v2" } as SettingField,
};

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: "general",
    name: "通用",
    desc: "全局演示开关，auto 时无 Key 自动走 Mock",
    fields: [FIELD.mockMode],
  },
  {
    id: "text",
    name: "文本",
    desc: "剧本 / 分镜 / 角色提炼等 LLM 能力",
    fields: [FIELD.textProvider, FIELD.textApiKey, FIELD.textModel],
  },
  {
    id: "image",
    name: "图片",
    desc: "定妆照 / 空镜 / 分镜出图能力",
    fields: [FIELD.imageProvider, FIELD.imageApiKey, FIELD.imageModel],
  },
  {
    id: "video",
    name: "视频",
    desc: "图生视频微动态能力",
    fields: [FIELD.videoProvider, FIELD.videoApiKey, FIELD.videoSecret, FIELD.videoModel],
  },
  {
    id: "audio",
    name: "音频",
    desc: "TTS 配音引擎与默认音色",
    fields: [FIELD.ttsEngine, FIELD.ttsApiKey, FIELD.ttsModel, FIELD.ttsVoice],
  },
];

/** 平铺全部字段（向后兼容旧引用） */
export const SETTING_FIELDS: SettingField[] = SETTING_GROUPS.flatMap((g) => g.fields);

// ========== 工具 ==========

/** 配置键 → 环境变量名：text.apiKey → TEXT_API_KEY */
export function settingKeyToEnv(key: string): string {
  return key
    .replaceAll(".", "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

type EnvSource = "env.local" | "env" | "db" | "mock" | "none";

/** 判定字段当前生效来源（.env.local > .env > DB/默认 > 空） */
function detectSource(
  envKey: string,
  envFiles: Record<string, Record<string, string>>,
  hasValue: boolean
): { source: EnvSource; file?: string } {
  const local = envFiles[".env.local"]?.[envKey];
  if (local) return { source: "env.local", file: ".env.local" };
  const dotenv = envFiles[".env"]?.[envKey];
  if (dotenv) return { source: "env", file: ".env" };
  if (hasValue) return { source: "db" };
  return { source: "none" };
}

// ========== 组件 ==========

export default function SettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [envFiles, setEnvFiles] = useState<Record<string, Record<string, string>>>({});
  const [envFileNames, setEnvFileNames] = useState<string[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [activeGroup, setActiveGroup] = useState<string>("general");
  const [syncEnv, setSyncEnv] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const j = (await res.json()) as { settings: Record<string, string> };
          setValues(j.settings);
        }
      } finally {
        setLoaded(true);
      }
    })();
    void (async () => {
      try {
        const res = await fetch("/api/env");
        if (res.ok) {
          const j = (await res.json()) as { files: { file: string; vars: { key: string; value: string }[] }[] };
          const map: Record<string, Record<string, string>> = {};
          const names: string[] = [];
          for (const f of j.files) {
            map[f.file] = Object.fromEntries(f.vars.map((v) => [v.key, v.value]));
            names.push(f.file);
          }
          setEnvFiles(map);
          setEnvFileNames(names);
        }
      } catch {
        // env 读取失败不影响主表单
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
        body: JSON.stringify({ settings: changes, syncEnv }),
      });
      if (res.ok) {
        setDirty(new Set());
        setMsg(syncEnv ? "已保存，并同步写入 .env.local ✓" : "已保存 ✓");
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

  const groupDirtyCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of SETTING_GROUPS) {
      m.set(g.id, g.fields.filter((f) => dirty.has(f.key)).length);
    }
    return m;
  }, [dirty]);

  const active = SETTING_GROUPS.find((g) => g.id === activeGroup) ?? SETTING_GROUPS[0];

  if (!loaded) {
    return <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">加载设置…</section>;
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">供应商设置</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            Key 仅保存在本地数据库；可选同步写入 <code>.env.local</code> 与代码层次关联。
            未修改的字段不会提交（避免覆盖脱敏值）。
          </p>
        </div>
      </div>

      {/* 左右栏布局：左=分组导航，右=字段 */}
      <div className="mt-5 flex flex-col gap-5 md:flex-row">
        {/* 左栏：分组列表 */}
        <nav className="flex shrink-0 flex-row flex-wrap gap-1.5 md:w-44 md:flex-col" aria-label="供应商分组">
          {SETTING_GROUPS.map((g) => {
            const activeTab = g.id === activeGroup;
            const cnt = groupDirtyCount.get(g.id) ?? 0;
            return (
              <button
                key={g.id}
                onClick={() => setActiveGroup(g.id)}
                className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition ${
                  activeTab
                    ? "bg-violet-600 text-white shadow-sm"
                    : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
                }`}
              >
                {g.name}
                {cnt > 0 && (
                  <span
                    className={`ml-0.5 rounded-full px-1.5 text-[10px] leading-4 ${
                      activeTab ? "bg-white/25 text-white" : "bg-violet-600 text-white"
                    }`}
                  >
                    {cnt}
                  </span>
                )}
              </button>
            );
          })}
          {/* 环境变量文件提示 */}
          {envFileNames.length > 0 && (
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <p className="text-[11px] font-medium text-zinc-400">环境变量文件</p>
              {envFileNames.map((n) => (
                <p key={n} className="mt-1 font-mono text-[10px] text-zinc-600">{n}</p>
              ))}
            </div>
          )}
        </nav>

        {/* 右栏：当前分组字段 */}
        <div className="min-w-0 flex-1">
          <p className="mb-3 text-xs text-zinc-500">{active.desc}</p>
          <div className="grid gap-4 lg:grid-cols-2">
            {active.fields.map((f) => {
              const envKey = settingKeyToEnv(f.key);
              const src = detectSource(envKey, envFiles, Boolean(values[f.key]));
              return (
                <label key={f.key} className="block">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-zinc-200">{f.label}</span>
                    <code className="text-[10px] text-zinc-600">{f.key}</code>
                    {/* 来源徽标 */}
                    {src.source === "env.local" && (
                      <span className="rounded-full bg-emerald-950 px-1.5 py-px text-[10px] text-emerald-400">.env.local</span>
                    )}
                    {src.source === "env" && (
                      <span className="rounded-full bg-sky-950 px-1.5 py-px text-[10px] text-sky-400">.env</span>
                    )}
                    {src.source === "db" && (
                      <span className="rounded-full bg-amber-950 px-1.5 py-px text-[10px] text-amber-400">数据库</span>
                    )}
                    {src.source === "none" && (
                      <span className="rounded-full bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-500">Mock</span>
                    )}
                    <code className="text-[10px] text-zinc-700">{envKey}</code>
                  </div>
                  {f.type === "select" ? (
                    <select
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-violet-500"
                    >
                      {f.options?.map((o) => (
                        <option key={o || "_unset"} value={o}>{o || "（未配置·Mock）"}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={dirty.has(f.key) ? "" : "未设置（留空使用 Mock）"}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-violet-500"
                    />
                  )}
                  {f.hint && <p className="mt-1 text-[11px] text-zinc-600">{f.hint}</p>}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-zinc-800 pt-4">
        <button
          onClick={() => void save()}
          disabled={saving || dirty.size === 0}
          className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "保存中…" : dirty.size > 0 ? `保存 ${dirty.size} 项变更` : "保存"}
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={syncEnv}
            onChange={(e) => setSyncEnv(e.target.checked)}
            className="accent-violet-600"
          />
          同时写入 <code className="text-zinc-500">.env.local</code>（下次启动对代码层生效）
        </label>
        {msg && <span className="text-sm text-zinc-400">{msg}</span>}
        {dirty.size > 0 && (
          <span className="text-xs text-zinc-600">有未保存的修改，切换分组不会丢失</span>
        )}
      </div>
    </section>
  );
}
