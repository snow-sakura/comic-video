/**
 * 生成 Confucius4-TTS 参考音频（语音克隆音色种子）
 * 用法: npx tsx scripts/gen-reference-voices.ts
 * 用 Edge TTS 合成多句音色样本 → 转 wav 存 storage/reference-voices/
 */
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createEdgeTTSProvider, EDGE_TTS_VOICES } from "@/lib/providers/tts";
import { saveFile } from "@/lib/storage";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REF_DIR = join(process.cwd(), "storage", "reference-voices");

/** 每个音色合成一句固定参考文本（克隆音色特征即可，内容不重要） */
const REF_TEXT = "他是风沙里走来的独行客，眼底藏着经年的霜。";

async function main(): Promise<void> {
  await mkdir(REF_DIR, { recursive: true });
  const existing = await readdir(REF_DIR).catch(() => [] as string[]);
  const tts = createEdgeTTSProvider();
  for (const v of EDGE_TTS_VOICES) {
    const wavName = `${v.id}.wav`;
    if (existing.includes(wavName)) {
      console.log(`skip ${v.id} (exists)`);
      continue;
    }
    try {
      const handle = await tts.synthesize({ text: REF_TEXT, voiceId: v.id, format: "mp3" });
      if (handle.status !== "done" || !handle.result?.audioPath) {
        console.error(`FAIL ${v.id}: ${handle.error}`);
        continue;
      }
      // 转 wav 44.1k mono（gradio 克隆模型的标准输入）
      const srcPath = join(process.cwd(), "storage", handle.result.audioPath.replace(/^audio\//, ""));
      const tmpWav = join(REF_DIR, `${v.id}.raw.wav`);
      await execFileAsync("ffmpeg", ["-y", "-i", srcPath, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", tmpWav]);
      const buf = await import("node:fs/promises").then((m) => m.readFile(tmpWav));
      await writeFile(join(REF_DIR, wavName), buf);
      await import("node:fs/promises").then((m) => m.unlink(tmpWav));
      console.log(`OK ${v.id} (${buf.length} bytes)`);
    } catch (e) {
      console.error(`FAIL ${v.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("done");
}

main();
