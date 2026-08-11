/**
 * 环境变量加载验证脚本（tsx scripts/check-env.ts）
 *
 * 读取 .env 与 DB 配置，验证各类模型配置是否正确加载。
 * 排除 mock 模式干扰：当 MOCK_MODE=true 时提示并标记，不作为"已配置真实 Key"。
 */
import { loadEnv } from "@/lib/env";
import {
  getTextConfig,
  getImageConfig,
  getVideoConfig,
  getTTSConfig,
  getSetting,
  maskKey,
  shouldUseMock,
} from "@/lib/providers/settings";

async function main(): Promise<void> {
  loadEnv();

  const mockMode = (await getSetting<string>("mock.mode")) ?? "auto";
  console.log("=== 环境变量加载验证 ===");
  console.log(`MOCK_MODE = ${mockMode}`);
  if (mockMode === "true") {
    console.log("⚠️  当前为强制 mock 模式，真实 Key 不会被使用。");
    console.log("    如需验证真实配置加载，请设 MOCK_MODE=auto 或 false。\n");
  } else {
    console.log("ℹ️  非强制 mock 模式，将按 auto/false 规则判定真实调用。\n");
  }

  // 基础设施
  console.log("【基础设施】");
  console.log(`  DATABASE_URL = ${process.env.DATABASE_URL ?? "(未配置)"}`);
  console.log(`  REDIS_URL    = ${process.env.REDIS_URL ?? "(未配置)"}`);
  console.log(`  STORAGE_DIR  = ${process.env.STORAGE_DIR ?? "(默认 ./storage)"}`);
  console.log("");

  // 文本模型
  const text = await getTextConfig();
  console.log("【文本模型 LLM】");
  console.log(`  provider = ${text.provider}`);
  console.log(`  apiKey   = ${maskKey(text.apiKey)}  ${text.apiKey ? "✓" : "✗ 未配置"}`);
  console.log(`  model    = ${text.model}`);
  console.log(`  baseUrl  = ${text.baseUrl}`);
  console.log(`  → 真实模式将${(await shouldUseMock("text")) ? "走 Mock（缺 Key）" : "调用真实模型"}`);
  console.log("");

  // 图像
  const image = await getImageConfig();
  console.log("【图像模型】");
  console.log(`  provider = ${image.provider}`);
  console.log(`  apiKey   = ${maskKey(image.apiKey)}  ${image.apiKey ? "✓" : "✗ 未配置"}`);
  console.log(`  model    = ${image.model}`);
  console.log(`  baseUrl  = ${image.baseUrl}`);
  console.log(`  → 真实模式将${(await shouldUseMock("image")) ? "走 Mock（缺 Key）" : "调用真实模型"}`);
  console.log("");

  // 视频
  const video = await getVideoConfig();
  console.log("【视频模型】");
  console.log(`  provider = ${video.provider}`);
  console.log(
    `  apiKey   = ${maskKey(video.apiKey)}  ${video.apiKey ? "✓" : "✗ 未配置"}`
  );
  console.log(
    `  secret   = ${maskKey(video.secret)}  ${
      video.provider === "kling"
        ? video.secret ? "✓" : "✗ 可灵必需"
        : "(仅可灵需要)"
    }`
  );
  console.log(`  model    = ${video.model}`);
  console.log(`  baseUrl  = ${video.baseUrl}`);
  console.log(`  → 真实模式将${(await shouldUseMock("video")) ? "走 Mock（缺 Key）" : "调用真实模型"}`);
  console.log("");

  // TTS
  const tts = await getTTSConfig();
  console.log("【声音模型 TTS】");
  console.log(`  engine   = ${tts.engine || "(未配置 → Mock)"}`);
  console.log(
    `  apiKey   = ${maskKey(tts.apiKey)}  ${
      tts.engine === "cosyvoice"
        ? tts.apiKey ? "✓" : "✗ cosyvoice 必需"
        : "(仅 cosyvoice 需要)"
    }`
  );
  console.log(`  model    = ${tts.model || "(默认 cosyvoice-v2)"}`);
  console.log(`  voice    = ${tts.voice || "(默认 zh-CN-YunxiNeural)"}`);
  console.log(`  baseUrl  = ${tts.baseUrl || "(默认 dashscope.aliyuncs.com)"}`);
  console.log(`  → 真实模式将${(await shouldUseMock("tts")) ? "走 Mock" : "调用真实模型"}`);
  console.log("");

  // 汇总
  console.log("=== 汇总 ===");
  const missing: string[] = [];
  if (!text.apiKey) missing.push("TEXT_API_KEY");
  if (!image.apiKey) missing.push("IMAGE_API_KEY");
  if (!video.apiKey) missing.push("VIDEO_API_KEY");
  if (video.provider === "kling" && !video.secret) missing.push("VIDEO_SECRET（可灵必需）");
  if (tts.engine === "cosyvoice" && !tts.apiKey) missing.push("TTS_API_KEY（cosyvoice 必需）");

  if (mockMode === "true") {
    console.log("强制 mock 模式：Key 缺失不影响功能，全流程走占位实现。");
  } else if (missing.length > 0) {
    console.log(`⚠️  缺失真实 Key：${missing.join(", ")}`);
    console.log("    MOCK_MODE=auto 下这些类别会自动降级为 Mock；MOCK_MODE=false 下会抛鉴权失败。");
  } else {
    console.log("✓ 所有必需 Key 已配置，真实模式可用。");
  }
}

main().catch((e) => {
  console.error("验证失败:", e);
  process.exit(1);
});
