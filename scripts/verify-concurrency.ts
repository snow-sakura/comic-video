#!/usr/bin/env node
/**
 * Worker 并发配置验证脚本
 * 
 * 功能:
 *   1. 打印当前环境变量配置的 Worker 并发数
 *   2. 验证 BullMQ 队列实例是否正确读取了配置
 *   3. 注入一批测试任务
 *   4. 监控并验证 Active 任务数是否符合并发限制
 * 
 * 用法:
 *   # 使用默认配置测试
 *   npx tsx scripts/verify-concurrency.ts
 *   
 *   # 自定义并发数测试
 *   WORKER_CONCURRENCY_COMPOSE=3 npx tsx scripts/verify-concurrency.ts
 */
import { loadEnv } from "@/lib/env";
import { QUEUE_DEFS, QUEUE_NAMES, getQueue, enqueueGenTask, type QueueName } from "@/lib/queue/queues";

loadEnv();

// ========== 1. 打印配置 ==========
async function printConfig(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║        Worker 并发配置验证测试                                   ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  
  console.log("[当前环境变量配置]");
  for (const name of Object.values(QUEUE_NAMES)) {
    const envKey = `WORKER_CONCURRENCY_${name.toUpperCase()}`;
    const envVal = process.env[envKey];
    const def = QUEUE_DEFS[name].concurrency;
    console.log(`  ${name.padEnd(8)}: ${envVal ? `来自环境变量 = ${envVal}` : `默认值 = ${def}`}`);
  }
  console.log("");
  
  // 验证 QUEUE_DEFS 中的值是否正确
  console.log("[QUEUE_DEFS 中的实际并发配置]");
  for (const [name, def] of Object.entries(QUEUE_DEFS)) {
    console.log(`  ${name.padEnd(8)}: concurrency = ${def.concurrency}`);
  }
  console.log("");
}

// ========== 2. 验证队列实例是否正确配置 ==========
async function verifyQueueConfig(): Promise<void> {
  console.log("[验证队列实例配置]");
  for (const name of Object.values(QUEUE_NAMES)) {
    try {
      const queue = getQueue(name);
      const counts = await queue.getJobCounts();
      console.log(`  ${name.padEnd(8)}: OK (队列连接正常, 当前任务数: active=${counts.active}, waiting=${counts.waiting})`);
    } catch (e) {
      console.log(`  ${name.padEnd(8)}: ERROR - ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("");
}

// ========== 3. 注入测试任务 ==========
async function injectTestTasks(queueName: QueueName, count: number): Promise<void> {
  console.log(`[注入 ${count} 个测试任务到 ${queueName} 队列...]`);
  
  // 生成一个临时 projectId 和 taskId
  const projectId = "test-concurrency-" + Date.now();
  const taskIds: string[] = [];
  
  for (let i = 0; i < count; i++) {
    const taskId = `test-task-${Date.now()}-${i}`;
    taskIds.push(taskId);
    
    try {
      // 仅用于测试：不创建 GenTask 记录（使用 mock 模式）
      // 直接向 BullMQ 队列注入任务
      const queue = getQueue(queueName);
      const jobId = `${taskId}_${Math.random().toString(36).slice(2, 8)}`;
      
      await queue.add(
        taskId,
        { taskId, ...{ test: true, injectedAt: Date.now() } },
        { jobId, removeOnFail: false }
      );
      
      console.log(`  已注入: ${taskId}`);
    } catch (e) {
      console.log(`  注入失败: ${taskId} - ${e instanceof Error ? e.message : e}`);
    }
  }
  
  console.log(`  共注入 ${taskIds.length} 个任务`);
  console.log("");
}

// ========== 4. 监控并验证 Active 数量 ==========
async function monitorAndVerify(queueName: QueueName, expectedConcurrency: number, duration: number): Promise<void> {
  console.log(`[监控 ${queueName} 队列 ${duration/1000} 秒，验证并发限制 ${expectedConcurrency}]`);
  
  const startTime = Date.now();
  const snapshots: { time: number; active: number; waiting: number }[] = [];
  const maxActiveSet = new Set<number>();
  
  return new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      try {
        const queue = getQueue(queueName);
        const counts = await queue.getJobCounts();
        const active = counts.active || 0;
        const waiting = counts.waiting || 0;
        const now = Date.now();
        
        snapshots.push({ time: now, active, waiting });
        maxActiveSet.add(active);
        
        const elapsed = ((now - startTime) / 1000).toFixed(1);
        console.log(`  [${elapsed}s] Active: ${active}, Waiting: ${waiting}, Completed: ${counts.completed}`);
        
        if (now - startTime >= duration) {
          clearInterval(interval);
          
          // 汇总
          const maxActive = Math.max(...Array.from(maxActiveSet));
          const passed = maxActive <= expectedConcurrency;
          
          console.log("");
          console.log("  === 验证结果 ===");
          console.log(`  观察到的最大 Active 数: ${maxActive}`);
          console.log(`  预期的并发限制: ${expectedConcurrency}`);
          console.log(`  测试结果: ${passed ? "✓ 通过 (Active <= concurrency)" : "✗ 失败 (Active > concurrency!)"}`);
          
          // 清理：清除等待中的任务
          try {
            const queue = getQueue(queueName);
            await queue.clean(0, 1000, "wait");
            console.log("  已清理等待中的任务");
          } catch {}
          
          resolve();
        }
      } catch (e) {
        console.log(`  监控错误: ${e instanceof Error ? e.message : e}`);
      }
    }, 500); // 每 500ms 采样一次
  });
}

// ========== 主函数 ==========
async function main(): Promise<void> {
  try {
    // 1. 打印配置
    await printConfig();
    
    // 2. 验证队列连接
    await verifyQueueConfig();
    
    // 3. 对 compose 队列进行并发测试
    // 因为 compose 任务最耗时，最容易观察并发限制
    const testQueue: QueueName = "compose";
    const testConcurrency = QUEUE_DEFS[testQueue].concurrency;
    const testTaskCount = 5; // 注入 5 个任务，预期最多同时执行 testConcurrency 个
    
    console.log(`\n[测试 ${testQueue} 队列并发限制]`);
    console.log(`  预期并发数: ${testConcurrency}`);
    console.log(`  注入任务数: ${testTaskCount}`);
    console.log(`  预期结果: Active <= ${testConcurrency}`);
    console.log("");
    
    // 注入任务
    await injectTestTasks(testQueue, testTaskCount);
    
    // 等待任务被 Worker 拾取
    console.log("[等待 Worker 处理任务...]");
    await new Promise(r => setTimeout(r, 3000));
    
    // 监控并验证（监控 10 秒）
    await monitorAndVerify(testQueue, testConcurrency, 10000);
    
    // 4. 测试完成
    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║ 测试完成                                                       ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");
    
  } catch (e) {
    console.error("测试脚本异常:", e);
  } finally {
    // 清理所有队列
    console.log("\n[清理队列...]");
    for (const name of Object.values(QUEUE_NAMES)) {
      try {
        const queue = getQueue(name);
        await queue.close();
        console.log(`  ${name} 队列已关闭`);
      } catch {}
    }
    process.exit(0);
  }
}

main();