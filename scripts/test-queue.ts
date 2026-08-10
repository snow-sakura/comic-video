/**
 * 队列层集成测试（tsx scripts/test-queue.ts）
 * 验证: 入队 → Worker 执行 → GenTask 状态联动（mock 模式）
 */
import { loadEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { enqueueGenTask, closeQueues, type QueueName } from "@/lib/queue/queues";
import { startWorker, closeWorkers } from "@/lib/queue/workers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitTaskDone(taskId: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await prisma.genTask.findUnique({ where: { id: taskId } });
    if (t?.status === "DONE") return;
    if (t?.status === "FAILED") throw new Error(`任务失败: ${t.error}`);
    await sleep(500);
  }
  throw new Error("等待任务完成超时");
}

async function createTask(type: string, provider: string, model: string): Promise<string> {
  const t = await prisma.genTask.create({
    data: { type: type as never, provider, model, status: "QUEUED" },
  });
  return t.id;
}

async function main(): Promise<void> {
  loadEnv();
  console.log("=== 队列层集成测试（Mock 模式） ===\n");

  // 启动全部 worker（当前进程内）
  const names = ["script", "image", "video", "audio", "compose"] as QueueName[];
  for (const n of names) startWorker(n);
  console.log("[0] workers 已启动\n");

  // 1. script 任务
  const t1 = await createTask("LLM", "doubao", "doubao-seed-1-6-250615");
  await enqueueGenTask("script", {
    taskId: t1,
    payload: { agent: "角色提取", input: "请提取这段故事中的主要角色" },
  });
  console.log(`[1] script 任务入队: ${t1}`);
  await waitTaskDone(t1);
  const r1 = await prisma.genTask.findUnique({ where: { id: t1 } });
  console.log(`    DONE ✓ (${String(r1?.error ?? "")})\n`);

  // 2. image 任务
  const t2 = await createTask("IMAGE", "seedream", "doubao-seedream-5-0-pro-260628");
  await enqueueGenTask("image", {
    taskId: t2,
    payload: { prompt: "测试分镜: 主角站在樱花树下", count: 1 },
  });
  console.log(`[2] image 任务入队: ${t2}`);
  await waitTaskDone(t2);
  console.log(`    DONE ✓\n`);

  // 3. video 任务（依赖 image 产物）
  const shot = await prisma.genTask.findUnique({ where: { id: t2 } });
  const shotPath = (shot?.input as { result?: { imagePaths?: string[] } } | null)?.result?.imagePaths?.[0];
  const t3 = await createTask("VIDEO", "kling", "kling-v3-0-omni");
  await enqueueGenTask("video", {
    taskId: t3,
    payload: { imagePath: shotPath ?? "", prompt: "人物轻微呼吸", duration: 5 },
  });
  console.log(`[3] video 任务入队: ${t3}`);
  await waitTaskDone(t3);
  console.log(`    DONE ✓\n`);

  // 4. audio 任务
  const t4 = await createTask("TTS", "cosyvoice", "cosyvoice-v2");
  await enqueueGenTask("audio", {
    taskId: t4,
    payload: { text: "你好，这里是测试配音", voiceId: "mock-female" },
  });
  console.log(`[4] audio 任务入队: ${t4}`);
  await waitTaskDone(t4);
  console.log(`    DONE ✓\n`);

  // 5. compose 占位
  const t5 = await createTask("COMPOSE", "ffmpeg", "local");
  await enqueueGenTask("compose", { taskId: t5, payload: { episodeId: "test" } });
  console.log(`[5] compose 任务入队: ${t5}`);
  await waitTaskDone(t5);
  console.log(`    DONE ✓\n`);

  console.log("=== 全部通过 ===");
  await closeWorkers();
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("测试失败:", e);
  await closeWorkers().catch(() => {});
  await closeQueues().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
