/**
 * GET /api/settings — 读取全部供应商配置（Key 脱敏）
 * PUT /api/settings — 保存配置（空值删除）；syncEnv=true 时同步写入 .env.local
 */
import { NextResponse } from "next/server";
import { getAllSettings, setSetting, deleteSetting, invalidateSettingCache } from "@/lib/providers/settings";
import { resetProviderCache } from "@/lib/providers/registry";
import { upsertEnvLocal } from "@/lib/env-write";
import { z } from "zod";

const SENSITIVE_KEYS = ["apiKey", "secret", "token", "password"];

/** 脱敏：key 含敏感词时只回显掩码 */
function maskValue(key: string, value: string): string {
  if (!SENSITIVE_KEYS.some((s) => key.includes(s))) return value;
  if (!value) return "";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

export async function GET(): Promise<NextResponse> {
  try {
    const all = await getAllSettings();
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      masked[k] = maskValue(k, v);
    }
    return NextResponse.json({ settings: masked });
  } catch (e) {
    console.error("[api/settings] GET", e);
    return NextResponse.json({ error: "读取设置失败" }, { status: 500 });
  }
}

const putSchema = z.object({
  /** 完整覆盖式保存：{ key: value }，value 为空字符串表示删除 */
  settings: z.record(z.string(), z.string()),
  /** 同时写入 .env.local（本地覆盖层，优先级高于 .env） */
  syncEnv: z.boolean().optional(),
});

export async function PUT(req: Request): Promise<NextResponse> {
  try {
    const body = putSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }
    const { settings, syncEnv } = body.data;
    for (const [key, value] of Object.entries(settings)) {
      if (value.trim() === "") {
        await deleteSetting(key);
      } else {
        await setSetting(key, value.trim());
      }
      // 同步写回 .env.local：text.apiKey → TEXT_API_KEY
      if (syncEnv) {
        const envKey = key
          .replaceAll(".", "_")
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .toUpperCase();
        try {
          upsertEnvLocal(envKey, value.trim());
        } catch (e) {
          console.warn("[api/settings] 写 .env.local 失败", envKey, e);
        }
      }
    }
    invalidateSettingCache();
    resetProviderCache();
    return NextResponse.json({ ok: true, syncedEnv: syncEnv === true });
  } catch (e) {
    console.error("[api/settings] PUT", e);
    return NextResponse.json({ error: "保存设置失败" }, { status: 500 });
  }
}
