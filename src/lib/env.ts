import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 安全加载 .env / .env.local（只填充未定义的变量，不覆盖已有值）。
 * Next.js 会自动加载 env；本工具确保 tsx 运行的 Worker 也能读到。
 * 优先级：.env.local > .env（与 Next.js 一致）
 */
export function loadEnv(): void {
  for (const file of [".env", ".env.local"]) {
    const p = resolve(process.cwd(), file);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // 去除引号
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    } catch {
      // 忽略解析错误
    }
  }
}
