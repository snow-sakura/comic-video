/**
 * .env.local 写入工具
 *
 * 设置页「供应商设置」与代码层次的 .env* 文件关联：
 *  - 保存时可选择同步写入 .env.local（本地覆盖层，优先级高于 .env）
 *  - 已有 KEY 行原地替换（保留注释与行序），空值删除该行
 *  - 新 KEY 追加到文件末尾
 *
 * 注意：Next.js dev 进程不会热加载运行时写入的 env，改动在下次启动时生效；
 * 但 DB 中的 ProviderSetting 优先于 env，设置页已写入 DB，故对运行时立即生效。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "@/lib/env";

loadEnv();

export const ENV_LOCAL_PATH = resolve(process.cwd(), ".env.local");

/** 值是否需要加引号（含空格 / # / = 时加双引号，保持与常见 .env 风格一致） */
function quoteValue(value: string): string {
  if (/[\s#="']/.test(value)) {
    // 内部含双引号时转义
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return value;
}

/** 更新 .env.local 中指定 KEY（不存在则追加；值为空字符串则删除该行）。返回是否发生变更 */
export function upsertEnvLocal(key: string, value: string): boolean {
  const file = ENV_LOCAL_PATH;
  const existed = existsSync(file);
  const lines: string[] = existed ? readFileSync(file, "utf8").split("\n") : [];
  const target = `${key}=`;

  if (value === "") {
    // 删除该 KEY 行
    const before = lines.length;
    const kept = lines.filter((l) => !l.startsWith(target));
    if (kept.length === before) return false;
    writeFileSync(file, kept.join("\n"));
    return true;
  }

  const line = `${target}${quoteValue(value)}`;
  const idx = lines.findIndex((l) => l.startsWith(target));
  if (idx !== -1) {
    if (lines[idx] === line) return false;
    lines[idx] = line;
  } else {
    // 文件末尾补空行分隔，再追加
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(line);
  }
  if (!existed) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  return true;
}
