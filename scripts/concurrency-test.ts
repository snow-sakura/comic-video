#!/usr/bin/env node
/**
 * 并发测试脚本 - 使用独立 Worker 验证并发限制
 * 
 * 这个脚本会:
 * 1. 启动一个临时 Worker，使用与主 Worker 相同的并发配置
 * 2. 向一个独立的测试队列注入耗时任务
 * 3. 验证 Active 数量不超过配置的并发数
 * 
 * 用法:
 *   # 先停止主 Worker（可选，避免冲突）
 *   pkill -f "scripts/worker"
 *   
 *   # 运行测试（设置 COMPOSE_CONCURRENCY=3）
 *   WORKER_CONCURRENCY_COMPOSE=3 npx tsx scripts/concurrency-test.ts
 */
import { loadEnv } from "@/lib/env";
import { getConnection } from "@/lib/queue/connection";

loadEnv();

async function main(): Promise<void> {
  const concurrency = Number(process.env.WORKER_CONCURRENCY_COMPOSE || 1);
  const jobCount = 5; // 注入 5 个任务
  const jobDuration = 3000; // 每个任务耗时 3 秒

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║     并发限制验证测试 - 独立 Worker                              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`配置: concurrency=${concurrency}, tasks=${jobCount}, duration=${jobDuration}ms`);
  console.log("");

  const { Worker, Queue } = await import("bullmq");

  // 使用独立的测试队列名（避免与主 Worker 冲突）
  const TEST_QUEUE_NAME = "compose_test";
  
  const connection = getConnection();
  
  console.log("[1/4] 创建测试队列...");
  const queue = new Queue(TEST_QUEUE_NAME, { connection });
  queue.on("error", (err) => console.error(`[queue error] ${err.message}`));
  console.log(`  ✓ 队列 ${TEST_QUEUE_NAME} 已创建`);

  console.log("\n[2/4] 启动测试 Worker...");
  
  // 追踪活跃任务数
  let activeTasks = 0;
  let maxActiveTasks = 0;
  const taskStartTimes: Map<string, number> = new Map();
  
  const worker = new Worker(
    TEST_QUEUE_NAME,
    async (job) => {
      const jobId = job.id || "unknown";
      activeTasks++;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      taskStartTimes.set(jobId, Date.now());
      
      console.log(`  [START] Job ${jobId} | 活跃: ${activeTasks} | 并发限制: ${concurrency}`);
      
      // 模拟耗时任务
      await new Promise(resolve => setTimeout(resolve, jobDuration));
      
      const duration = Date.now() - (taskStartTimes.get(jobId) || Date.now());
      activeTasks--;
      console.log(`  [END]   Job ${jobId} | 耗时: ${duration}ms | 剩余活跃: ${activeTasks}`);
      
      return { success: true, duration };
    },
    { 
      connection, 
      concurrency,
      stalledInterval: 30000,
      maxStalledCount: 1,
    }
  );
  
  worker.on("error", (err) => console.error(`[worker error] ${err.message}`));
  worker.on("failed", (job, err) => console.error(`[FAILED] Job ${job?.id}: ${err.message}`));
  console.log(`  ✓ Worker 已启动 (concurrency=${concurrency})`);

  console.log(`\n[3/4] 注入 ${jobCount} 个耗时任务...`);
  
  const jobIds: string[] = [];
  for (let i = 0; i < jobCount; i++) {
    const jobId = `test-job-${Date.now()}-${i}`;
    const job = await queue.add(
      `task-${i}`,
      { sequence: i },
      { jobId, removeOnComplete: true, attempts: 1 }
    );
    jobIds.push(job.id || jobId);
    console.log(`  ✓ 已注入: ${job.id || jobId}`);
  }

  console.log(`\n[4/4] 等待所有任务完成...`);
  
  // 等待所有任务完成（最多等待 60 秒）
  const startTime = Date.now();
  const maxWaitTime = 60000;
  
  while (Date.now() - startTime < maxWaitTime) {
    const counts = await queue.getJobCounts();
    const totalDone = counts.completed + counts.failed;
    
    if (totalDone >= jobCount) {
      break;
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                        测试结果                                 ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  
  // 获取最终统计
  const finalCounts = await queue.getJobCounts();
  console.log(`  总任务数: ${jobCount}`);
  console.log(`  最大同时活跃数: ${maxActiveTasks}`);
  console.log(`  配置的并发限制: ${concurrency}`);
  console.log("");
  
  const passed = maxActiveTasks <= concurrency;
  console.log(`  结果: ${passed ? "✓ 通过" : "✗ 失败"}`);
  console.log(`  ${passed ? "活跃数符合并发限制" : "活跃数超过了并发限制！"}`);
  console.log("");
  
  // 清理
  console.log("[清理] 关闭 Worker 和队列...");
  await worker.close();
  await queue.close();
  console.log("  ✓ 已清理");
  
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("测试异常:", err);
  process.exit(1);
});