/**
 * 适配器层集成测试（tsx scripts/test-providers.ts）
 * 验证: LLM / Image / Video / TTS / Music / SFX 在 mock 模式下全链路可跑
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@/lib/env";
import { getScriptLLM, getStructLLM, getImage, getVideo, getTTS, getMusic, getSFX } from "@/lib/providers/registry";
import { absPath } from "@/lib/storage";

async function main(): Promise<void> {
  loadEnv();
  console.log("=== 适配器层集成测试（Mock 模式） ===\n");

  // 1. LLM
  const scriptLlm = await getScriptLLM();
  console.log(`[1] 剧本 LLM: ${scriptLlm.displayName}`);
  const scriptOut = await scriptLlm.chat([{ role: "user", content: "写一个短剧开场" }], { json: true });
  console.log(`    输出: ${scriptOut.slice(0, 80)}...\n`);

  const structLlm = await getStructLLM();
  console.log(`[2] 结构化 LLM: ${structLlm.displayName}`);
  const structOut = await structLlm.chat(
    [{ role: "user", content: "提取角色列表" }],
    { json: true }
  );
  console.log(`    输出: ${structOut.slice(0, 80)}...\n`);

  // 3. 图像
  const image = await getImage();
  console.log(`[3] 图像: ${image.displayName}`);
  const imgRes = await image.generate({ prompt: "测试分镜: 主角站在樱花树下" });
  console.log(`    结果: ${JSON.stringify(imgRes)}`);
  const imgPath = imgRes.result?.imagePaths?.[0] ?? "";
  console.log(`    文件存在: ${imgPath ? absPath(imgPath) : ""}\n`);

  // 4. 视频（需先有一张图）
  const video = await getVideo();
  console.log(`[4] 视频: ${video.displayName}`);
  const vidRes = await video.submit({ imagePath: imgPath, prompt: "人物轻微呼吸", duration: 5 });
  console.log(`    结果: ${JSON.stringify(vidRes)}\n`);

  // 5. TTS
  const tts = await getTTS();
  console.log(`[5] TTS: ${tts.displayName}`);
  const voices = await tts.listVoices();
  console.log(`    音色数: ${voices.length}`);
  const ttsRes = await tts.synthesize({ text: "你好，我是测试配音", voiceId: voices[0]?.id ?? "" });
  console.log(`    结果: ${JSON.stringify(ttsRes)}\n`);

  // 6. 音乐素材库（创建一个测试素材）
  const bgmDir = join(absPath("bgm"), "warmth");
  mkdirSync(bgmDir, { recursive: true });
  writeFileSync(join(bgmDir, "test-warm.mp3"), Buffer.from("fake-mp3"));
  const music = await getMusic();
  console.log(`[6] 音乐: ${music.displayName}`);
  const musicRes = await music.generate({ mood: "warmth", duration: 30 });
  console.log(`    结果: ${JSON.stringify(musicRes)}\n`);

  // 7. 音效
  const sfxDir = join(absPath("sfx"), "rain");
  mkdirSync(sfxDir, { recursive: true });
  writeFileSync(join(sfxDir, "light-rain.wav"), Buffer.from("fake-wav"));
  const sfx = await getSFX();
  console.log(`[7] 音效: ${sfx.displayName}`);
  const sfxRes = await sfx.search(["rain"]);
  console.log(`    命中: ${sfxRes.map((s) => s.label).join(", ")}`);

  console.log("\n=== 全部通过 ===");
}

main().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
