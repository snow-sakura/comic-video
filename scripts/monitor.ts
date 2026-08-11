#!/usr/bin/env node
/**
 * 队列状态实时监控脚本
 * 
 * 用法:
 *   npx tsx scripts/monitor.ts            # 运行一次后退出
 *   npx tsx scripts/monitor.ts --watch     # 持续监控（每 2s 刷新一次，Ctrl+C 退出）
 * 
 * 功能:
 *   1. 显示各队列的 Job 统计（active/waiting/completed/failed）
 *   2. 显示 Redis 客户端连接数（需要 redis-cli 在 PATH 中）
 *   3. 帮助评估 Worker 并发配置效果
 */
import { execSync } from "node:child_process";
import { loadEnv } from "@/lib/env";
import { getQueue, QUEUE_NAMES } from "@/lib/queue/queues";

loadEnv();

async function getRedisClientCount(): Promise<string> {
  try {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    const urlObj = new URL(url);
    const host = urlObj.hostname || "localhost";
    const port = urlObj.port || "6379";
    const password = urlObj.password ? decodeURIComponent(urlObj.password) : "";
    
    let cmd = `redis-cli -h ${host} -p ${port}`;
    if (password) cmd += ` -a ${password}`;
    cmd += " INFO clients | grep connected_clients";
    
    const output = execSync(cmd, { encoding: "utf8", timeout: 2000 });
    return output.trim().split(":")[1]?.trim() || "N/A";
  } catch {
    return "N/A (redis-cli not found)";
  }
}

async function runOnce(): Promise<void> {
  console.clear();
  const now = new Date().toLocaleTimeString();
  console.log(`=== 漫剧视频生成器 - 队列状态监控 (${now}) ===`);
  console.log("");

  // Redis 连接数
  const redisClients = await getRedisClientCount();
  console.log(`[Redis] 客户端连接数: ${redisClients}`);
  console.log("");

  // 队列状态表
  console.log("[BullMQ 队列状态]");
  console.log("-------------------------------------------------------------------------------------------------");
  console.log("队列名      | Active (执行中) | Waiting (等待) | Completed | Failed | Delayed | Prioritized");
  console.log("-------------------------------------------------------------------------------------------------");

  for (const name of Object.values(QUEUE_NAMES)) {
    try {
      const queue = getQueue(name);
      const counts = await queue.getJobCounts();
      
      console.log(
        `${name.padEnd(12)} | ${String(counts.active || 0).padEnd(15)} | ${String(counts.waiting || 0).padEnd(14)} | ${String(counts.completed || 0).padEnd(9)} | ${String(counts.failed || 0).padEnd(7)} | ${String(counts.delayed || 0).padEnd(8)} | ${String(counts.prioritized || 0)}`
      );
    } catch (e) {
      console.log(`${name.padEnd(12)} | ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  
  console.log("-------------------------------------------------------------------------------------------------");
  console.log("提示: Active 数量不应超过该队列的 Worker 并发数 (concurrency)");
}

async function main(): Promise<void> {
  const watch = process.argv.includes("--watch");
  
  if (watch) {
    console.log("进入持续监控模式，每 2 秒刷新一次 (Ctrl+C 退出)...");
    // 首次立即执行
    await runOnce();
    setInterval(runOnce, 2000);
  } else {
    await runOnce();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("监控脚本异常:", err);
  process.exit(1);
});