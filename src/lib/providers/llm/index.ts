/**
 * LLM 供应商实现：智谱 GLM(默认) / DeepSeek / 豆包(火山方舟) / Mock
 *
 * 所有 provider 仅读取 text.* 分类配置（text.apiKey / text.model / text.baseUrl），
 * 不混读其他类别。GLM 与豆包均兼容 OpenAI 接口，统一用 @ai-sdk/openai。
 */
import { generateText, streamText } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMMessage, LLMOptions, LLMProvider } from "@/lib/providers/types";
import { getTextConfig, maskKey, startTimer } from "@/lib/providers/settings";

export const GLM_PROVIDER_ID = "glm";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DOUBAO_PROVIDER_ID = "doubao";

/**
 * AI SDK v7 的 generateText/streamText 默认不允许 messages 中出现 system 角色
 * （allowSystemInMessages=false，会抛 "System messages are not allowed...
 * Use the instructions option instead."）。官方推荐将系统提示放顶层 system 参数。
 * 这里把 messages 中的 system 消息提取为顶层 system 字符串（chat completions
 * 协议下会被转回 system 消息，智谱/豆包/DeepSeek 均支持）。
 */
function splitSystemMessages(
  messages: LLMMessage[]
): { system?: string; messages: LLMMessage[] } {
  const systemParts: string[] = [];
  const rest: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      rest.push(m);
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}

/**
 * 智谱 GLM 请求中间件：注入 thinking: { type: "disabled" } 关闭思考模式。
 * glm-4.7 系列默认开启思考，reasoning_tokens 会吃光小 maxTokens 的预算
 * 导致输出为空，并显著增加延迟（每次调用多花 2-4s）。
 * AI SDK 的 providerOptions 不透传自定义字段，故用自定义 fetch 注入。
 */
function zhipuFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (init?.body) {
    try {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (!body.thinking) body.thinking = { type: "disabled" };
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // 非 JSON body 原样透传
    }
  }
  return fetch(input, init);
}

// ========== 智谱 GLM（默认，OpenAI 兼容端点） ==========

export function createGlmProvider(): LLMProvider {
  return {
    id: GLM_PROVIDER_ID,
    displayName: "智谱清言 GLM",
    async chat(messages: LLMMessage[], opts?: LLMOptions) {
      const cfg = await getTextConfig();
      const temp = opts?.temperature ?? 0.7;
      const maxTokens = opts?.maxTokens ?? 8192;
      console.log(`[llm:glm] 调用 model=${cfg.model} baseUrl=${cfg.baseUrl} key=${maskKey(cfg.apiKey)} msgs=${messages.length} json=${!!opts?.json} temp=${temp} maxTokens=${maxTokens}`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[llm:glm] 鉴权失败：TEXT_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw new Error("未配置 TEXT_API_KEY（智谱 GLM）");
      }
      const provider = createOpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl,
        fetch: zhipuFetch,
      });
      const { system, messages: restMessages } = splitSystemMessages(messages);
      try {
        const { text, usage } = await generateText({
          model: provider.chat(cfg.model),
          ...(system !== undefined ? { system } : {}),
          messages: restMessages,
          temperature: temp,
          maxOutputTokens: maxTokens,
          maxRetries: 4, // 智谱免费档高峰期间歇限流（1305），加大重试
          ...(opts?.json ? { responseFormat: { type: "json" } as never } : {}),
        });
        console.log(`[llm:glm] 成功 output=${text.length}字 usage=${JSON.stringify(usage ?? {})} 耗时=${elapsed()}ms`);
        return text;
      } catch (e) {
        console.error(`[llm:glm] 失败 model=${cfg.model} baseUrl=${cfg.baseUrl} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions) {
      const cfg = await getTextConfig();
      const temp = opts?.temperature ?? 0.7;
      console.log(`[llm:glm] 流式调用 model=${cfg.model} baseUrl=${cfg.baseUrl} key=${maskKey(cfg.apiKey)} msgs=${messages.length} temp=${temp}`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[llm:glm] 鉴权失败：TEXT_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw new Error("未配置 TEXT_API_KEY（智谱 GLM）");
      }
      const provider = createOpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl,
        fetch: zhipuFetch,
      });
      const { system, messages: restMessages } = splitSystemMessages(messages);
      try {
        const result = streamText({
          model: provider.chat(cfg.model),
          ...(system !== undefined ? { system } : {}),
          messages: restMessages,
          temperature: temp,
          maxRetries: 4,
        });
        for await (const chunk of result.textStream) {
          yield chunk;
        }
        console.log(`[llm:glm] 流式成功 model=${cfg.model} 耗时=${elapsed()}ms`);
      } catch (e) {
        console.error(`[llm:glm] 流式失败 model=${cfg.model} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
  };
}

// ========== DeepSeek ==========

export function createDeepSeekProvider(): LLMProvider {
  return {
    id: DEEPSEEK_PROVIDER_ID,
    displayName: "DeepSeek V3",
    async chat(messages: LLMMessage[], opts?: LLMOptions) {
      const cfg = await getTextConfig();
      const temp = opts?.temperature ?? 0.7;
      const maxTokens = opts?.maxTokens ?? 8192;
      const model = cfg.model || "deepseek-chat";
      console.log(`[llm:deepseek] 调用 model=${model} key=${maskKey(cfg.apiKey)} msgs=${messages.length} json=${!!opts?.json} temp=${temp} maxTokens=${maxTokens}`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[llm:deepseek] 鉴权失败：TEXT_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw new Error("未配置 TEXT_API_KEY（DeepSeek）");
      }
      const provider = createDeepSeek({ apiKey: cfg.apiKey });
      const { system, messages: restMessages } = splitSystemMessages(messages);
      try {
        const { text, usage } = await generateText({
          model: provider.chat(model),
          ...(system !== undefined ? { system } : {}),
          messages: restMessages,
          temperature: temp,
          maxOutputTokens: maxTokens,
          ...(opts?.json ? { responseFormat: { type: "json" } as never } : {}),
        });
        console.log(`[llm:deepseek] 成功 output=${text.length}字 usage=${JSON.stringify(usage ?? {})} 耗时=${elapsed()}ms`);
        return text;
      } catch (e) {
        console.error(`[llm:deepseek] 失败 model=${model} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions) {
      const cfg = await getTextConfig();
      const temp = opts?.temperature ?? 0.7;
      const model = cfg.model || "deepseek-chat";
      console.log(`[llm:deepseek] 流式调用 model=${model} key=${maskKey(cfg.apiKey)} msgs=${messages.length} temp=${temp}`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[llm:deepseek] 鉴权失败：TEXT_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw new Error("未配置 TEXT_API_KEY（DeepSeek）");
      }
      const provider = createDeepSeek({ apiKey: cfg.apiKey });
      const { system, messages: restMessages } = splitSystemMessages(messages);
      try {
        const result = streamText({
          model: provider.chat(model),
          ...(system !== undefined ? { system } : {}),
          messages: restMessages,
          temperature: temp,
        });
        for await (const chunk of result.textStream) {
          yield chunk;
        }
        console.log(`[llm:deepseek] 流式成功 model=${model} 耗时=${elapsed()}ms`);
      } catch (e) {
        console.error(`[llm:deepseek] 流式失败 model=${model} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
  };
}

// ========== 豆包（火山方舟，OpenAI 兼容端点） ==========

const DOUBAO_BASE = "https://ark.cn-beijing.volces.com/api/v3";

export function createDoubaoProvider(): LLMProvider {
  return {
    id: DOUBAO_PROVIDER_ID,
    displayName: "豆包 Doubao-Seed",
    async chat(messages: LLMMessage[], opts?: LLMOptions) {
      const cfg = await getTextConfig();
      const temp = opts?.temperature ?? 0.5;
      const maxTokens = opts?.maxTokens ?? 8192;
      const model = cfg.model || "doubao-seed-1-6-250615";
      console.log(`[llm:doubao] 调用 model=${model} baseUrl=${DOUBAO_BASE} key=${maskKey(cfg.apiKey)} msgs=${messages.length} json=${!!opts?.json} temp=${temp} maxTokens=${maxTokens}`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[llm:doubao] 鉴权失败：TEXT_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw new Error("未配置 TEXT_API_KEY（火山方舟豆包）");
      }
      const provider = createOpenAI({ apiKey: cfg.apiKey, baseURL: DOUBAO_BASE });
      const { system, messages: restMessages } = splitSystemMessages(messages);
      try {
        const { text, usage } = await generateText({
          model: provider.chat(model),
          ...(system !== undefined ? { system } : {}),
          messages: restMessages,
          temperature: temp,
          maxOutputTokens: maxTokens,
          ...(opts?.json ? { responseFormat: { type: "json" } as never } : {}),
        });
        console.log(`[llm:doubao] 成功 output=${text.length}字 usage=${JSON.stringify(usage ?? {})} 耗时=${elapsed()}ms`);
        return text;
      } catch (e) {
        console.error(`[llm:doubao] 失败 model=${model} baseUrl=${DOUBAO_BASE} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions) {
      const cfg = await getTextConfig();
      const temp = opts?.temperature ?? 0.5;
      const model = cfg.model || "doubao-seed-1-6-250615";
      console.log(`[llm:doubao] 流式调用 model=${model} baseUrl=${DOUBAO_BASE} key=${maskKey(cfg.apiKey)} msgs=${messages.length} temp=${temp}`);
      const elapsed = startTimer();
      if (!cfg.apiKey) {
        console.error(`[llm:doubao] 鉴权失败：TEXT_API_KEY 未配置 耗时=${elapsed()}ms`);
        throw new Error("未配置 TEXT_API_KEY（火山方舟豆包）");
      }
      const provider = createOpenAI({ apiKey: cfg.apiKey, baseURL: DOUBAO_BASE });
      const { system, messages: restMessages } = splitSystemMessages(messages);
      try {
        const result = streamText({
          model: provider.chat(model),
          ...(system !== undefined ? { system } : {}),
          messages: restMessages,
          temperature: temp,
        });
        for await (const chunk of result.textStream) {
          yield chunk;
        }
        console.log(`[llm:doubao] 流式成功 model=${model} 耗时=${elapsed()}ms`);
      } catch (e) {
        console.error(`[llm:doubao] 流式失败 model=${model} 耗时=${elapsed()}ms error=${e instanceof Error ? e.message : String(e)}`);
        throw e;
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
      const last = messages[messages.length - 1]?.content ?? "";
      if (opts?.json) {
        return JSON.stringify({
          mock: true,
          note: "未配置 API Key，当前为 Mock 输出。请在设置页或 .env 配置 TEXT_API_KEY / TEXT_MODEL。",
          echo: last.slice(0, 200),
        });
      }
      return `【Mock 输出】未配置 API Key。请在 .env 配置 TEXT_API_KEY / TEXT_MODEL 后重新生成。\n\n（输入摘要：${last.slice(0, 300)}）`;
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
  const cfg = await getTextConfig();
  const providerId = id ?? cfg.provider;
  if (providerId === GLM_PROVIDER_ID) return createGlmProvider();
  if (providerId === DEEPSEEK_PROVIDER_ID) return createDeepSeekProvider();
  if (providerId === DOUBAO_PROVIDER_ID) return createDoubaoProvider();
  return createMockLLMProvider();
}
