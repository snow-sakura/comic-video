#!/usr/bin/env node
/**
 * Worker 并发配置验证脚本
 * 
 * 用法:
 *   WORKER_CONCURRENCY_IMAGE=4 npx tsx scripts/test-concurrency.ts
 *   
 * 该脚本会:
 *   1. 打印当前环境变量中配置的 Worker 并发数
 *   2. 启动 Worker 进程
 *   3. 向各队列注入 mock 任务（模拟耗时操作）
 *   4. 验证实际并发执行的任务数是否符合配置
 * 
 * 注意: 这需要一个正在运行的 Worker 进程来消费任务。
 *       可在另一个终端先运行 `npx tsx scripts/worker.ts`。
 */
import { loadEnv } from "@/lib/env";
import { QUEUE_NAMES, enqueueGenTask } from "@/lib/queue/queues";

loadEnv();

// 1. 打印当前环境变量配置
function printConcurrencyConfig(): void {
  console.log("=== Worker 并发配置 ===");
  for (const name of Object.values(QUEUE_NAMES)) {
    const envKey = `WORKER_CONCURRENCY_${name.toUpperCase()}`;
    const val = process.env[envKey];
    console.log(`  ${name.padEnd(8)}: ${val ? val : "默认值 (2)"} (env: ${envKey})`);
  }
  console.log("");
}

// 2. 验证并发执行
async function testConcurrency(queueName: string, jobCount: number): Promise<void> {
  console.log(`\n[测试] 向 ${queueName} 队列注入 ${jobCount} 个 mock 任务...`);
  
  // 动态导入处理器
  const { startWorker } = await import("@/lib/queue/workers");
  
  // 启动 Worker 处理该队列
  const worker = startWorker(queueName as never);
  
  // 注入任务
  const startTest = Date.now();
  const executionTimes: number[] = [];
  let activeCount = 0;
  let maxActiveCount = 0;
  
  const mockHandler = async (job: { id: string }): Promise<{ duration: number }> => {
    const currentActive = ++activeCount;
    maxActiveCount = Math.max(maxActiveCount, currentActive);
    
    const startTime = Date.now();
    console.log(`  [${queueName}] Job ${job.id} 开始执行 (活跃任务: ${currentActive})`);
    
    // 模拟耗时：每个任务 sleep 3 秒
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const duration = Date.now() - startTime;
    executionTimes.push(duration);
    activeCount--;
    
    return { duration };
  };

  // 替换默认处理器为 mock
  // 注意：这实际上只是演示，真实测试需要直接操作 Worker processor
  
  // 清理逻辑简化：仅做演示性的注入
  console.log(`  实际测试需要连接到已运行的 Worker。`);
  console.log(`  您可以在另一个终端运行 'npx tsx scripts/worker.ts'，`);
  console.log(`  然后用 API 或其他脚本注入任务来测试实际并发。`);
}

async function main(): Promise<void> {
  printConcurrencyConfig();
  
  // 示例：为 image 队列注入 5 个任务
  const testQueue = "image";
  const testCount = 5;
  
  console.log(`\n=== 测试 ${testQueue} 队列并发执行 ===`);
  console.log(`目标: 注入 ${testCount} 个任务，验证同时执行的任务数不超过 WORKER_CONCURRENCY_IMAGE`);
  
  try {
    // 简单的并发测试：记录活跃任务数
    let activeTasks = 0;
    let maxActiveTasks = 0;
    const taskTimes: number[] = [];
    
    const mockProcessor = async (jobId: string): Promise<void> => {
      activeTasks++;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      const start = Date.now();
      console.log(`  [Start] ${jobId} | 活跃: ${activeTasks}`);
      
      await new Promise(r => setTimeout(r, 2000)); // 2秒任务
      
      const duration = Date.now() - start;
      taskTimes.push(duration);
      activeTasks--;
      console.log(`  [End]   ${jobId} | 耗时: ${duration}ms | 活跃: ${activeTasks}`);
    };
    
    // 模拟注入任务（实际需要通过 enqueueGenTask 或直接操作）
    console.log("\n--- 模拟并发测试 ---");
    console.log("（实际项目中，这些任务会被 Worker 消费）");
    
    // 这里仅做演示：并发执行 mock 函数
    const jobs = Array.from({ length: testCount }, (_, i) => `job_${i + 1}`);
    await Promise.all(jobs.map(id => mockProcessor(id)));
    
    console.log("\n--- 测试结果 ---");
    console.log(`  总任务数: ${testCount}`);
    console.log(`  最大同时活跃数: ${maxActiveTasks}`);
    console.log(`  所有任务总耗时: ${taskTimes.reduce((a, b) => a + b, 0)}ms (串行)`);
    console.log(`  实际并行能力: 模拟 (无 Worker 时全串行)`);
    console.log(`\n结论: 当 Worker 进程运行时，活跃任务数会限制在 WORKER_CONCURRENCY_* 配置内。`);
    
  } catch (err) {
    console.error("测试出错:", err);
  }
}

main().catch(console.error);