/**
 * Worker 进程入口（生产模式）
 * 运行: npx tsx scripts/worker.ts
 */
import { startAllWorkers, closeWorkers, setWorkersPaused } from "@/lib/queue/workers";
import { getPipelinePaused } from "@/lib/pipeline";

/** 流水线状态轮询间隔（ms）：web 端「继续执行/暂停」只更新 DB，
 *  独立 worker 进程需轮询感知状态变化并同步到本进程 Worker 实例 */
const PIPELINE_POLL_MS = 3000;

async function main(): Promise<void> {
  const workers = await startAllWorkers();
  console.log(`[worker] 已启动 ${workers.length} 个队列 worker`);
  for (const w of workers) {
    console.log(`  - ${w.name} (concurrency=${w.opts.concurrency})`);
  }

  // 流水线状态同步：web 进程与 worker 进程分离，
  // web 端「继续执行/暂停」写入 PipelineControl 表，此处轮询并在变化时同步
  let lastPaused = await getPipelinePaused();
  const poller = setInterval(async () => {
    try {
      const paused = await getPipelinePaused();
      if (paused !== lastPaused) {
        console.log(
          `[worker] 检测到流水线状态变化: ${lastPaused ? "暂停" : "运行中"} → ${paused ? "暂停" : "运行中"}，同步 worker...`,
        );
        await setWorkersPaused(paused);
        lastPaused = paused;
      }
    } catch (e) {
      console.error(`[worker] 流水线状态同步失败: ${e instanceof Error ? e.message : e}`);
    }
  }, PIPELINE_POLL_MS);

  console.log("[worker] 监听中，Ctrl+C 退出");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[worker] 收到 ${signal}，关闭中...`);
    clearInterval(poller);
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
