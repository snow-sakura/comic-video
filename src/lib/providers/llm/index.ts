/**
 * LLM 供应商实现：DeepSeek / 豆包(火山方舟) / Mock
 */
import { generateText, streamText } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMMessage, LLMOptions, LLMProvider } from "@/lib/providers/types";
import { getApiKey, getSetting } from "@/lib/providers/settings";

export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DOUBAO_PROVIDER_ID = "doubao";

// ========== DeepSeek ==========

export function createDeepSeekProvider(): LLMProvider {
  return {
    id: DEEPSEEK_PROVIDER_ID,
    displayName: "DeepSeek V3",
    async chat(messages: LLMMessage[], opts?: LLMOptions) {
      const apiKey = (await getApiKey("deepseek")) ?? "";
      const model = (await getSetting<string>("llm.deepseek.model")) ?? "deepseek-chat";
      const provider = createDeepSeek({ apiKey });
      const { text } = await generateText({
        model: provider.chat(model),
        messages,
        temperature: opts?.temperature ?? 0.7,
        maxOutputTokens: opts?.maxTokens ?? 8192,
        ...(opts?.json ? { responseFormat: { type: "json" } as never } : {}),
      });
      return text;
    },
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions) {
      const apiKey = (await getApiKey("deepseek")) ?? "";
      const model = (await getSetting<string>("llm.deepseek.model")) ?? "deepseek-chat";
      const provider = createDeepSeek({ apiKey });
      const result = streamText({
        model: provider.chat(model),
        messages,
        temperature: opts?.temperature ?? 0.7,
      });
      for await (const chunk of result.textStream) {
        yield chunk;
      }
    },
  };
}

// ========== 豆包（火山方舟，OpenAI 兼容端点） ==========

export function createDoubaoProvider(): LLMProvider {
  return {
    id: DOUBAO_PROVIDER_ID,
    displayName: "豆包 Doubao-Seed",
    async chat(messages: LLMMessage[], opts?: LLMOptions) {
      const apiKey = (await getApiKey("ark")) ?? "";
      const model = (await getSetting<string>("llm.doubao.model")) ?? "doubao-seed-1-6-250615";
      const provider = createOpenAI({
        apiKey,
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      });
      const { text } = await generateText({
        model: provider.chat(model),
        messages,
        temperature: opts?.temperature ?? 0.5,
        maxOutputTokens: opts?.maxTokens ?? 8192,
        ...(opts?.json ? { responseFormat: { type: "json" } as never } : {}),
      });
      return text;
    },
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions) {
      const apiKey = (await getApiKey("ark")) ?? "";
      const model = (await getSetting<string>("llm.doubao.model")) ?? "doubao-seed-1-6-250615";
      const provider = createOpenAI({
        apiKey,
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      });
      const result = streamText({
        model: provider.chat(model),
        messages,
        temperature: opts?.temperature ?? 0.5,
      });
      for await (const chunk of result.textStream) {
        yield chunk;
      }
    },
  };
}

// ========== Mock（无 Key 时保证全流程可跑通） ==========

export function createMockLLMProvider(): LLMProvider {
  return {
    id: "mock-llm",
    displayName: "Mock LLM（无Key演示）",
    async chat(messages: LLMMessage[], opts?: LLMOptions) {
      // 返回与输入长度相关的占位 JSON/文本
      const last = messages[messages.length - 1]?.content ?? "";
      if (opts?.json) {
        return JSON.stringify({
          mock: true,
          note: "未配置 API Key，当前为 Mock 输出。请在设置页配置 DeepSeek / 火山方舟 Key。",
          echo: last.slice(0, 200),
        });
      }
      return `【Mock 输出】未配置 API Key。请到「设置」页配置对应平台的 Key 后重新生成。\n\n（输入摘要：${last.slice(0, 300)}）`;
    },
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions) {
      const out = await this.chat(messages, opts);
      // 分块模拟流式
      for (let i = 0; i < out.length; i += 20) {
        yield out.slice(i, i + 20);
      }
    },
  };
}

// ========== 工厂 ==========

export async function createLLMProvider(id?: string): Promise<LLMProvider> {
  const providerId = id ?? (await getSetting<string>("llm.scriptProvider")) ?? "deepseek";
  if (providerId === DEEPSEEK_PROVIDER_ID) return createDeepSeekProvider();
  if (providerId === DOUBAO_PROVIDER_ID) return createDoubaoProvider();
  return createMockLLMProvider();
}
