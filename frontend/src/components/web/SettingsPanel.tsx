import { useEffect, useMemo, useState } from "react";

// ========== 设置表单 schema（按能力分组） ==========

interface SettingField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  options?: string[];
  hint?: string;
  /** catalog 联动：select 的选项来自 /api/models */
  catalogRole?: "textProvider" | "textModel" | "imageProvider" | "imageModel" | "videoProvider" | "videoModel" | "ttsEngine" | "ttsModel";
}

interface SettingGroup {
  id: string;
  name: string;
  desc: string;
  fields: SettingField[];
}

/** /api/models 返回的模型目录（后端 app/providers/catalog.py） */
interface CatalogModel {
  id: string;
  name: string;
  ctx?: string;
  tags?: string[];
  note?: string;
  status?: string;
}
interface CatalogProvider {
  id: string;
  name: string;
  baseUrl?: string;
  requiresKey?: boolean;
  apiKeyHint?: string;
  models: CatalogModel[];
  voices?: { id: string; name: string }[];
  note?: string;
  status?: string;
}
interface ModelCatalog {
  text?: { providers: CatalogProvider[]; defaults?: Record<string, string> };
  image?: { providers: CatalogProvider[]; defaults?: Record<string, string> };
  video?: { providers: CatalogProvider[]; defaults?: Record<string, string> };
  tts?: { engines: CatalogProvider[]; defaults?: Record<string, string> };
}

/** 模型下拉中的「自定义」哨兵值 */
const CUSTOM_MODEL = "__custom__";

/** 平铺字段（无 catalog 时的静态回退；有 catalog 时选项被动态覆盖） */
const FIELD = {
  mockMode: { key: "mock.mode", label: "Mock 模式", type: "select", options: ["auto", "true", "false"], hint: "auto=有 Key 用真、无 Key 自动演示" } as SettingField,
  // 文本（LLM）
  textProvider: { key: "text.provider", label: "文本引擎", type: "select", options: ["agnes", "openai", "mock"], catalogRole: "textProvider", hint: "agnes=Agnes AI（官方默认） | openai=通用兼容 | mock=演示" } as SettingField,
  textApiKey: { key: "text.apiKey", label: "文本 API Key", type: "password", hint: "对应 .env 的 TEXT_API_KEY" } as SettingField,
  textModel: { key: "text.model", label: "文本模型", type: "select", options: [], catalogRole: "textModel", hint: "默认 agnes-3.0-flash（免费档）；可选自定义输入" } as SettingField,
  textBaseUrl: { key: "text.baseUrl", label: "文本 Base URL", type: "text", hint: "默认 https://apihub.agnes-ai.com/v1；openai 兼容端点可自定义" } as SettingField,
  // 图像
  imageProvider: { key: "image.provider", label: "图像引擎", type: "select", options: ["agnes", "mock"], catalogRole: "imageProvider", hint: "agnes=Agnes AI（官方默认） | mock=演示" } as SettingField,
  imageApiKey: { key: "image.apiKey", label: "图像 API Key", type: "password", hint: "对应 .env 的 IMAGE_API_KEY" } as SettingField,
  imageModel: { key: "image.model", label: "图像模型", type: "select", options: [], catalogRole: "imageModel", hint: "默认 agnes-image-2.5-flash（当前免费）" } as SettingField,
  // 视频
  videoProvider: { key: "video.provider", label: "视频引擎", type: "select", options: ["agnes", "mock"], catalogRole: "videoProvider", hint: "agnes=Agnes AI（官方默认，限流1次/分） | mock=演示" } as SettingField,
  videoApiKey: { key: "video.apiKey", label: "视频 API Key", type: "password", hint: "对应 .env 的 VIDEO_API_KEY" } as SettingField,
  videoModel: { key: "video.model", label: "视频模型", type: "select", options: [], catalogRole: "videoModel", hint: "默认 agnes-video-2.5-flash（限时免费）" } as SettingField,
  // 音频（TTS）
  ttsEngine: { key: "tts.engine", label: "TTS 引擎", type: "select", options: ["", "edge-tts", "mimo", "tokendance", "confucius4", "voxcpm"], catalogRole: "ttsEngine", hint: "留空=Mock | edge-tts=微软免费 | mimo=小米MiMo-TTS(官方免费额度) | tokendance=TokenDance音频网关(按量) | confucius4/voxcpm=本地" } as SettingField,
  ttsApiKey: { key: "tts.apiKey", label: "TTS API Key", type: "password", hint: "mimo（小米 MiMo）等云端引擎需要；edge-tts / confucius4 / voxcpm 无需" } as SettingField,
  ttsModel: { key: "tts.model", label: "TTS 模型", type: "select", options: [], catalogRole: "ttsModel", hint: "如 mimo-v2.5-tts（按引擎联动）" } as SettingField,
  ttsVoice: { key: "tts.voice", label: "TTS 默认音色", type: "text", hint: "如 zh-CN-YunxiNeural（edge-tts）/ 引擎默认音色 ID" } as SettingField,
  ttsBaseUrl: { key: "tts.baseUrl", label: "TTS Base URL", type: "text", hint: "默认 https://api.xiaomimimo.com/v1；可指向 TokenDance 等兼容网关" } as SettingField,
};

/** 静态分组（catalog 未加载时的回退渲染） */
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
    fields: [FIELD.textProvider, FIELD.textApiKey, FIELD.textModel, FIELD.textBaseUrl],
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
    fields: [FIELD.videoProvider, FIELD.videoApiKey, FIELD.videoModel],
  },
  {
    id: "audio",
    name: "音频",
    desc: "TTS 配音引擎与默认音色",
    fields: [FIELD.ttsEngine, FIELD.ttsApiKey, FIELD.ttsModel, FIELD.ttsVoice, FIELD.ttsBaseUrl],
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

/** 取某能力的 provider/engine 列表（catalog） */
function providersOf(catalog: ModelCatalog | null, category: "text" | "image" | "video" | "tts"): CatalogProvider[] {
  if (!catalog) return [];
  if (category === "tts") return catalog.tts?.engines ?? [];
  return catalog[category]?.providers ?? [];
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
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  /** 强制使用自定义模型输入框的字段 */
  const [customModel, setCustomModel] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      try {
        const [settingsRes, envRes, modelsRes] = await Promise.all([
          fetch("/api/settings"),
          fetch("/api/env").catch(() => null),
          fetch("/api/models").catch(() => null),
        ]);
        if (settingsRes.ok) {
          const j = (await settingsRes.json()) as { settings: Record<string, string> };
          setValues(j.settings);
        }
        if (envRes?.ok) {
          const j = (await envRes.json()) as { files: { file: string; vars: { key: string; value: string }[] }[] };
          const map: Record<string, Record<string, string>> = {};
          const names: string[] = [];
          for (const f of j.files) {
            map[f.file] = Object.fromEntries(f.vars.map((v) => [v.key, v.value]));
            names.push(f.file);
          }
          setEnvFiles(map);
          setEnvFileNames(names);
        }
        if (modelsRes?.ok) {
          const j = (await modelsRes.json()) as { catalog: ModelCatalog };
          setCatalog(j.catalog);
        }
      } finally {
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
        body: JSON.stringify({ settings: changes, syncEnv }),
      });
      if (res.ok) {
        setDirty(new Set());
        setMsg(syncEnv ? "已保存，并同步写入 .env.local ✓（重启后端后对代码层生效）" : "已保存 ✓（provider_settings 数据库）");
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

  /** 当前分组各字段的动态选项（catalog 联动） */
  function optionsForField(f: SettingField): string[] | undefined {
    if (!f.catalogRole || !catalog) return f.options;
    switch (f.catalogRole) {
      case "textProvider":
        return providersOf(catalog, "text").map((p) => p.id);
      case "imageProvider":
        return providersOf(catalog, "image").map((p) => p.id);
      case "videoProvider":
        return providersOf(catalog, "video").map((p) => p.id);
      case "ttsEngine":
        return providersOf(catalog, "tts").map((e) => e.id);
      case "textModel":
      case "imageModel":
      case "videoModel":
      case "ttsModel": {
        const category = f.catalogRole.replace("Model", "") as "text" | "image" | "video" | "tts";
        const providerKey = category === "tts" ? "tts.engine" : `${category}.provider`;
        const provider = values[providerKey] ?? "";
        const list = providersOf(catalog, category).find((p) => p.id === provider);
        const ids = (list?.models ?? []).map((m) => m.id);
        const current = values[f.key] ?? "";
        // 当前值不在目录中 → 追加为自定义项；并始终提供「自定义输入…」
        if (current && !ids.includes(current) && !customModel.has(f.key)) ids.push(current);
        return [...ids, CUSTOM_MODEL];
      }
      default:
        return f.options;
    }
  }

  function modelNote(f: SettingField): string | undefined {
    if (!catalog || !f.catalogRole?.endsWith("Model")) return f.hint;
    const category = f.catalogRole.replace("Model", "") as "text" | "image" | "video" | "tts";
    const providerKey = category === "tts" ? "tts.engine" : `${category}.provider`;
    const provider = values[providerKey] ?? "";
    const list = providersOf(catalog, category).find((p) => p.id === provider);
    const m = list?.models.find((x) => x.id === values[f.key]);
    if (m?.note) return `${m.name} — ${m.note}`;
    return f.hint;
  }

  if (!loaded) {
    return <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">加载设置…</section>;
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">供应商设置</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            模型列表来自官方目录（Agnes / 小米 MiMo / TokenDance）；Key 仅保存在本地数据库；
            可选同步写入 <code>.env.local</code>。未修改的字段不会提交（避免覆盖脱敏值）。
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
              const isCustomText = customModel.has(f.key);
              const opts = optionsForField(f);
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
                  {f.type === "select" && !isCustomText ? (
                    <select
                      value={values[f.key] ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === CUSTOM_MODEL) {
                          setCustomModel((prev) => new Set(prev).add(f.key));
                          // 保留现值以便用户在其基础上修改
                          setDirty((prev) => new Set(prev).add(f.key));
                          return;
                        }
                        setCustomModel((prev) => {
                          const next = new Set(prev);
                          next.delete(f.key);
                          return next;
                        });
                        setValue(f.key, v);
                      }}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-violet-500"
                    >
                      {opts?.map((o) => (
                        <option key={o || "_unset"} value={o}>
                          {o === CUSTOM_MODEL
                            ? "✍️ 自定义输入…"
                            : o === "mimo"
                              ? "mimo（小米 MiMo-TTS·官方免费额度）"
                              : o === "tokendance"
                                ? "tokendance（TokenDance 音频网关·按量计费）"
                                : o || "（未配置·Mock）"}
                        </option>
                      ))}
                      {(values[f.key] ?? "") === "" && f.catalogRole?.endsWith("Model") && (
                        <option value="">（未选择·按引擎默认）</option>
                      )}
                    </select>
                  ) : (
                    <input
                      type={isCustomText ? "text" : f.type}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={dirty.has(f.key) ? "" : "未设置（留空使用默认/Mock）"}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-violet-500"
                    />
                  )}
                  {isCustomText && (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomModel((prev) => {
                          const next = new Set(prev);
                          next.delete(f.key);
                          return next;
                        });
                      }}
                      className="mt-1 text-[11px] text-violet-400 hover:text-violet-300"
                    >
                      ← 返回目录选择
                    </button>
                  )}
                  {(modelNote(f) || f.hint) && <p className="mt-1 text-[11px] text-zinc-600">{modelNote(f) || f.hint}</p>}
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
          同时写入 <code className="text-zinc-500">.env.local</code>（重启后端后对代码层生效）
        </label>
        {msg && <span className="text-sm text-zinc-400">{msg}</span>}
        {dirty.size > 0 && (
          <span className="text-xs text-zinc-600">有未保存的修改，切换分组不会丢失</span>
        )}
      </div>
    </section>
  );
}
