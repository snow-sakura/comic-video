#!/usr/bin/env node
/**
 * 任务注入脚本（独立于 Worker 运行）
 * 
 * 用法:
 *   # 先在另一个终端启动 Worker
 *   WORKER_CONCURRENCY_COMPOSE=3 npm run worker
 *   
 *   # 然后在本终端注入任务
 *   npx tsx scripts/inject-tasks.ts
 */
import { loadEnv } from "@/lib/env";
import { getQueue, QUEUE_NAMES, type QueueName } from "@/lib/queue/queues";

loadEnv();

async function injectTasks(queueName: QueueName, count: number): Promise<void> {
  console.log(`[向 ${queueName} 队列注入 ${count} 个测试任务...]`);
  
  const queue = getQueue(queueName);
  
  for (let i = 0; i < count; i++) {
    const taskId = `test-${queueName}-${Date.now()}-${i}`;
    const jobId = `${taskId}_${Math.random().toString(36).slice(2, 8)}`;
    
    try {
      await queue.add(
        taskId,
        { taskId, test: true, injectedAt: Date.now(), duration: 5000 }, // 模拟 5 秒任务
        { jobId, removeOnFail: false, attempts: 1 }
      );
      console.log(`  ✓ 已注入: ${taskId}`);
    } catch (e) {
      console.log(`  ✗ 注入失败: ${taskId} - ${e instanceof Error ? e.message : e}`);
    }
  }
  
  // 不关闭队列，让 Worker 可以继续处理
  console.log(`  共注入 ${count} 个任务\n`);
}

async function main(): Promise<void> {
  const queue = (process.argv[2] || "compose") as QueueName;
  const count = Number(process.argv[3] || "5");
  
  if (!Object.values(QUEUE_NAMES).includes(queue)) {
    console.error(`无效的队列名: ${queue}`);
    console.error(`可选队列: ${Object.values(QUEUE_NAMES).join(", ")}`);
    process.exit(1);
  }
  
  console.log(`=== 任务注入脚本 ===`);
  console.log(`目标队列: ${queue}`);
  console.log(`注入数量: ${count}`);
  console.log("");
  
  await injectTasks(queue, count);
  
  console.log("提示: 运行 'npm run monitor' 查看 Worker 处理情况");
  process.exit(0);
}

main().catch(console.error);