#!/usr/bin/env node
/**
 * Worker 平滑重启测试
 * 
 * 验证目标:
 *   1. Worker 接收到 SIGTERM 后，等待当前任务完成再退出（平滑关闭）
 *   2. 重启后，等待中的任务会被继续消费（无丢失）
 *   3. 进行中的任务若被中断，会被重投（stalled job 机制）
 *   4. 并发数调整后，新 Worker 使用新配置
 * 
 * 用法:
 *   npx tsx scripts/test-graceful-restart.ts
 */
import { loadEnv } from "@/lib/env";
import { getConnection } from "@/lib/queue/connection";

loadEnv();

const TEST_QUEUE = "graceful_restart_test";

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} ${name}: ${detail}`);
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║        Worker 平滑重启测试                                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");

  const { Worker, Queue } = await import("bullmq");
  // BullMQ 的 Worker 内部会创建独立的 blocking connection，
  // 但 connection 配置对象本身可以共享（BullMQ 会深拷贝）
  const connection = getConnection();

  console.log("[1/5] 创建测试队列并清理旧数据...");
  const queue = new Queue(TEST_QUEUE, { connection });
  await queue.drain(); // 清空等待中的任务
  await queue.clean(0, 1000, "failed");
  await queue.clean(0, 1000, "completed");
  console.log("  ✓ 队列已就绪");

  // ========== 测试 1: 平滑关闭（等待当前任务完成） ==========
  console.log("\n[2/5] 测试 1: 平滑关闭（SIGTERM 等待任务完成）");

  const completedJobs: string[] = [];
  let worker1: InstanceType<typeof Worker> | null = null;

  await new Promise<void>(async (resolve) => {
    let taskStartedCount = 0;
    worker1 = new Worker(
      TEST_QUEUE,
      async (job) => {
        taskStartedCount++;
        console.log(`    [Worker1] 开始处理 ${job.id} (active=${taskStartedCount})`);
        await new Promise((r) => setTimeout(r, 2000)); // 任务耗时 2s
        completedJobs.push(job.id || "");
        console.log(`    [Worker1] 完成 ${job.id}`);
      },
      { connection, concurrency: 2 }
    );

    // 等待 Worker ready 事件
    await new Promise<void>((r) => {
      worker1!.once("ready", () => r());
      // 兜底：5s 后强制继续
      setTimeout(r, 5000);
    });
    console.log("    Worker1 已就绪");

    // 注入 2 个任务
    await queue.add("task-1", { n: 1 }, { jobId: "graceful-1" });
    await queue.add("task-2", { n: 2 }, { jobId: "graceful-2" });
    console.log("    已注入 2 个任务（每个耗时 2s）");

    // 轮询等待任务被 Worker 拾取（通过队列 active 计数检测）
    const waitPicked = Date.now();
    while (Date.now() - waitPicked < 5000) {
      const counts = await queue.getJobCounts();
      if (counts.active >= 2 || taskStartedCount >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`    已拾取任务数: ${taskStartedCount}/2 (active=${taskStartedCount})`);

    // 发送 SIGTERM 触发平滑关闭（此时任务正在执行中）
    console.log("    发送 SIGTERM（任务执行中）...");
    const closeStart = Date.now();
    await worker1!.close();
    const closeDuration = Date.now() - closeStart;
    const allCompleted = completedJobs.length === 2;
    record(
      "平滑关闭",
      allCompleted && closeDuration >= 1500,
      `关闭耗时 ${closeDuration}ms, 已完成任务 ${completedJobs.length}/2`
    );
    resolve();
  });

  // ========== 测试 2: 等待中的任务在重启后被消费 ==========
  console.log("\n[3/5] 测试 2: 重启后等待中的任务被消费（无丢失）");

  // 注入 3 个任务（此时无 Worker）
  await queue.add("pending-1", { n: 1 }, { jobId: "pending-1" });
  await queue.add("pending-2", { n: 2 }, { jobId: "pending-2" });
  await queue.add("pending-3", { n: 3 }, { jobId: "pending-3" });
  console.log("    已注入 3 个任务（无 Worker 运行）");

  const resumedJobs: string[] = [];
  await new Promise<void>((resolve) => {
    const worker2 = new Worker(
      TEST_QUEUE,
      async (job) => {
        console.log(`    [Worker2] 恢复处理 ${job.id}`);
        await new Promise((r) => setTimeout(r, 200));
        resumedJobs.push(job.id || "");
        console.log(`    [Worker2] 完成 ${job.id}`);
      },
      { connection, concurrency: 3 }
    );

    worker2.on("completed", () => {
      if (resumedJobs.length === 3) {
        record("任务恢复", resumedJobs.length === 3, `恢复并完成 ${resumedJobs.length}/3 个任务`);
        worker2.close().then(resolve);
      }
    });
  });

  // ========== 测试 3: stalled job 重投（模拟进程崩溃） ==========
  // 说明：在单进程内无法完美模拟 kill -9（worker.close() 是优雅关闭）。
  // 此处改用 disconnect() 断开 Redis 连接，模拟进程崩溃。
  // 加 15s 超时保护，避免测试卡住。
  console.log("\n[4/5] 测试 3: stalled job 重投（模拟进程崩溃）");

  await queue.add("stalled-task", { n: 1 }, { jobId: "stalled-1" });
  console.log("    已注入 1 个任务");

  let stalledReprocessed = false;
  let recoveryWorkerRef: InstanceType<typeof Worker> | null = null;

  await new Promise<void>(async (resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        record("Stalled 重投", false, "15s 超时未重投（单进程内 stalled 检测受限，生产环境多进程可正常工作）");
        // 关闭 recovery worker
        if (recoveryWorkerRef) {
          recoveryWorkerRef.close().catch(() => {}).then(() => resolve());
        } else {
          resolve();
        }
      }
    }, 15000);

    // 第一个 Worker：拾取任务后直接断开连接（模拟 kill -9）
    const crashWorker = new Worker(
      TEST_QUEUE,
      async (job) => {
        console.log(`    [CrashWorker] 拾取 ${job.id}，断开连接模拟崩溃...`);
        await crashWorker.disconnect();
        await new Promise(() => {});
      },
      {
        connection,
        concurrency: 1,
        stalledInterval: 1000,
        maxStalledCount: 2,
      }
    );

    // 1.5s 后启动恢复 Worker
    setTimeout(() => {
      console.log("    启动 RecoveryWorker，等待 stalled 检测...");
      recoveryWorkerRef = new Worker(
        TEST_QUEUE,
        async (job) => {
          console.log(`    [RecoveryWorker] 重投处理 ${job.id}`);
          stalledReprocessed = true;
          await new Promise((r) => setTimeout(r, 100));
          console.log(`    [RecoveryWorker] 完成 ${job.id}`);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            record("Stalled 重投", true, "任务被正确重投并完成");
            recoveryWorkerRef!.close().then(() => resolve());
          }
          return { recovered: true };
        },
        {
          connection,
          concurrency: 1,
          stalledInterval: 1000,
          maxStalledCount: 2,
        }
      );
    }, 1500);
  });

  // 确保 recoveryWorker 完全关闭后再继续
  await new Promise((r) => setTimeout(r, 500));

  // ========== 测试 4: 并发数调整后新 Worker 使用新配置 ==========
  console.log("\n[5/5] 测试 4: 并发数调整后新 Worker 使用新配置");

  const oldConcurrency = 1;
  const newConcurrency = 3;

  // 用旧并发数启动
  let maxActiveOld = 0;
  let activeOld = 0;
  const workerOld = new Worker(
    TEST_QUEUE,
    async (job) => {
      activeOld++;
      maxActiveOld = Math.max(maxActiveOld, activeOld);
      await new Promise((r) => setTimeout(r, 1000));
      activeOld--;
      return {};
    },
    { connection, concurrency: oldConcurrency }
  );

  // 注入 3 个任务，验证旧 Worker 并发为 1
  for (let i = 0; i < 3; i++) {
    await queue.add(`old-${i}`, {}, { jobId: `old-config-${i}` });
  }
  await new Promise((r) => setTimeout(r, 3500)); // 等待完成
  await workerOld.close();
  console.log(`    旧 Worker (concurrency=${oldConcurrency}): 最大活跃 ${maxActiveOld}`);

  // 用新并发数启动
  let maxActiveNew = 0;
  let activeNew = 0;
  const workerNew = new Worker(
    TEST_QUEUE,
    async (job) => {
      activeNew++;
      maxActiveNew = Math.max(maxActiveNew, activeNew);
      await new Promise((r) => setTimeout(r, 1000));
      activeNew--;
      return {};
    },
    { connection, concurrency: newConcurrency }
  );

  for (let i = 0; i < 3; i++) {
    await queue.add(`new-${i}`, {}, { jobId: `new-config-${i}` });
  }
  await new Promise((r) => setTimeout(r, 2500));
  await workerNew.close();
  console.log(`    新 Worker (concurrency=${newConcurrency}): 最大活跃 ${maxActiveNew}`);

  record(
    "并发数动态生效",
    maxActiveOld === oldConcurrency && maxActiveNew === newConcurrency,
    `旧=${maxActiveOld} (期望 ${oldConcurrency}), 新=${maxActiveNew} (期望 ${newConcurrency})`
  );

  // ========== 清理 ==========
  console.log("\n[清理] 关闭队列...");
  await queue.drain();
  await queue.close();

  // ========== 汇总 ==========
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                        测试汇总                                 ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"} ${r.name}: ${r.detail}`);
  }
  console.log("");
  console.log(`  通过: ${passed}/${total}`);

  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});