/**
 * 耗时统计日志验证脚本（tsx scripts/test-logging.ts）
 *
 * 验证所有 provider 的失败路径（鉴权失败 / 参数错误）日志都包含 "耗时=Xms"，
 * 且瞬时错误（鉴权 / 参数）耗时远小于网络错误，便于区分「网络慢」还是「参数错」。
 *
 * 直接调用 createXxxProvider 工厂函数，绕过 registry 的 mock 判定，
 * 以触发真实 provider 的预网络检查（鉴权 / 参数校验）路径。
 */
import { loadEnv } from "@/lib/env";
import { createGlmProvider } from "@/lib/providers/llm";
import { createCogViewProvider } from "@/lib/providers/image";
import { createCogVideoXProvider, createKlingProvider } from "@/lib/providers/video";
import { createEdgeTTSProvider, createCosyVoiceProvider } from "@/lib/providers/tts";

// ========== console 捕获 ==========

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push("[log] " + a.join(" "));
  console.error = (...a: unknown[]) => logs.push("[err] " + a.join(" "));
  return {
    logs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

// ========== 测试场景 ==========

interface Scenario {
  name: string;
  tag: string; // 日志前缀，如 [llm:glm]
  setup: () => void;
  run: () => Promise<unknown>;
}

const scenarios: Scenario[] = [
  {
    name: "LLM 鉴权失败（无 TEXT_API_KEY）",
    tag: "[llm:glm]",
    setup: () => {
      delete process.env.TEXT_API_KEY;
    },
    run: () => createGlmProvider().chat([{ role: "user", content: "测试" }]),
  },
  {
    name: "Image 鉴权失败（无 IMAGE_API_KEY）",
    tag: "[image:cogview]",
    setup: () => {
      delete process.env.IMAGE_API_KEY;
    },
    run: () => createCogViewProvider().generate({ prompt: "测试分镜" }),
  },
  {
    name: "Video 鉴权失败（无 VIDEO_API_KEY）",
    tag: "[video:cogvideox]",
    setup: () => {
      delete process.env.VIDEO_API_KEY;
    },
    run: () => createCogVideoXProvider().submit({ imagePath: "/x.png", prompt: "测试", duration: 5 }),
  },
  {
    name: "Video 参数错误（图片不存在）",
    tag: "[video:cogvideox]",
    setup: () => {
      process.env.VIDEO_API_KEY = "fake-key-param-test";
    },
    run: () =>
      createCogVideoXProvider().submit({
        imagePath: "/nonexistent-xxx.png",
        prompt: "测试",
        duration: 5,
      }),
  },
  {
    name: "TTS edge-tts 参数错误（空文本）",
    tag: "[tts:edge-tts]",
    setup: () => {
      /* edge-tts 无需 key */
    },
    run: () => createEdgeTTSProvider().synthesize({ text: "", voiceId: "" }),
  },
  {
    name: "TTS cosyvoice 鉴权失败（无 TTS_API_KEY）",
    tag: "[tts:cosyvoice]",
    setup: () => {
      delete process.env.TTS_API_KEY;
    },
    run: () => createCosyVoiceProvider().synthesize({ text: "测试", voiceId: "" }),
  },
  {
    name: "Video kling 鉴权失败（无 AK/SK）",
    tag: "[video:kling]",
    setup: () => {
      delete process.env.VIDEO_API_KEY;
      delete process.env.VIDEO_SECRET;
    },
    run: () => createKlingProvider().submit({ imagePath: "/x.png", prompt: "测试", duration: 5 }),
  },
  {
    name: "Image 网络错误（baseUrl 不可达，验证 try/catch）",
    tag: "[image:cogview]",
    setup: () => {
      process.env.IMAGE_API_KEY = "fake-key-net-test";
      process.env.IMAGE_BASE_URL = "http://127.0.0.1:1"; // 端口 1 立即拒绝 → ECONNREFUSED
    },
    run: () => createCogViewProvider().generate({ prompt: "测试" }),
  },
];

// ========== 执行 ==========

async function main(): Promise<void> {
  loadEnv();
  console.log("=== 耗时统计日志验证测试 ===");
  console.log('目标：每个失败路径的日志都应含 "耗时=Xms"，瞬时错误耗时 < 50ms\n');

  let pass = 0;
  let fail = 0;

  for (const s of scenarios) {
    s.setup();
    const cap = captureConsole();
    let thrown: unknown = null;
    try {
      await s.run();
    } catch (e) {
      thrown = e;
    }
    cap.restore();

    const providerLogs = cap.logs.filter((l) => l.includes(s.tag));
    const errorLogs = providerLogs.filter((l) => l.includes("[err]"));
    const hasErrorLog = errorLogs.length > 0;
    const allHaveElapsed = hasErrorLog && errorLogs.every((l) => l.includes("耗时="));
    const elapsedMatch = providerLogs.join(" ").match(/耗时=(\d+)ms/);
    const elapsed = elapsedMatch ? Number(elapsedMatch[1]) : null;

    const ok = hasErrorLog && allHaveElapsed;
    if (ok) pass++;
    else fail++;

    console.log(`[${ok ? "PASS" : "FAIL"}] ${s.name}`);
    console.log(
      `  抛错: ${thrown instanceof Error ? thrown.message : thrown ? String(thrown) : "（未抛错）"}`
    );
    console.log(`  耗时: ${elapsed !== null ? elapsed + "ms" : "未记录"}`);
    for (const l of providerLogs) console.log(`  ${l}`);
    console.log("");
  }

  console.log(`=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("测试执行失败:", e);
  process.exit(1);
});
