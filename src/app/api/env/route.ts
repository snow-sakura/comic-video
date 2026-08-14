/**
 * GET /api/env — 读取代码层次的 .env* 文件键值（敏感值脱敏）
 * 用于设置页「供应商设置」展示各配置项的来源（.env / .env.local / 数据库 / Mock）。
 */
import { NextResponse } from "next/server";
import { readEnvFiles } from "@/lib/env";

const SENSITIVE_KEYS = ["apiKey", "secret", "token", "password"];
const SENSITIVE_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASS|ACCESS)/i;

function isSensitive(name: string): boolean {
  return SENSITIVE_KEYS.some((s) => name.includes(s)) || SENSITIVE_RE.test(name);
}

function maskValue(name: string, value: string): string {
  if (!isSensitive(name) || !value) return value;
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

export async function GET(): Promise<NextResponse> {
  try {
    const { dotenv, local } = readEnvFiles();
    const files = [
      {
        file: ".env",
        vars: Object.entries(dotenv).map(([key, value]) => ({
          key,
          value: maskValue(key, value),
          sensitive: isSensitive(key),
        })),
      },
      {
        file: ".env.local",
        vars: Object.entries(local).map(([key, value]) => ({
          key,
          value: maskValue(key, value),
          sensitive: isSensitive(key),
        })),
      },
    ];
    return NextResponse.json({ files });
  } catch (e) {
    console.error("[api/env] GET", e);
    return NextResponse.json({ error: "读取环境变量失败" }, { status: 500 });
  }
}