/**
 * Worker 进程入口（生产模式）
 * 运行: npx tsx scripts/worker.ts
 */
import { startAllWorkers, closeWorkers } from "@/lib/queue/workers";

async function main(): Promise<void> {
  const workers = startAllWorkers();
  console.log(`[worker] 已启动 ${workers.length} 个队列 worker`);
  for (const w of workers) {
    console.log(`  - ${w.name} (concurrency=${w.opts.concurrency})`);
  }
  console.log("[worker] 监听中，Ctrl+C 退出");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[worker] 收到 ${signal}，关闭中...`);
    await closeWorkers();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[worker] 启动失败:", e);
  process.exit(1);
});
