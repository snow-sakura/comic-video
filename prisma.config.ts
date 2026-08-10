import { defineConfig, env } from "prisma/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Prisma 7 不会自动加载 .env，这里显式加载（.env.local 优先覆盖 .env）
for (const file of [".env", ".env.local"]) {
  const p = resolve(process.cwd(), file);
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      // ignore parse errors, keep going
    }
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
