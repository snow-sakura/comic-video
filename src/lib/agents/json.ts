/**
 * LLM 结构化输出容错解析
 */

/** 从 LLM 响应中提取 JSON（剥离 markdown fence、截断修复） */
export function safeParseJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  let text = raw.trim();
  // 剥离 ```json ... ``` 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // 找最外层 { ... } 或 [ ... ]
  const start = text.indexOf("{");
  if (start === -1) return null;
  const end = text.lastIndexOf("}");
  if (end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // 尝试修复：截断到最后一个完整字段（处理超长截断）
    const truncated = truncateJson(candidate);
    if (truncated !== candidate) {
      try {
        return JSON.parse(truncated) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 尝试修复被截断的 JSON：逐层删减尾部直到可解析 */
function truncateJson(text: string): string {
  // 从后往前找最后一个引号/逗号/括号位置，尝试截断
  for (let i = text.length - 1; i > text.length - 500 && i > 0; i--) {
    const ch = text[i];
    if (ch === "," || ch === "{" || ch === "[" || ch === '"' || ch === "}" || ch === "]") {
      const cut = text.slice(0, i);
      for (const closer of ["]", "}", "}}", "}]", "}}}"]) {
        try {
          JSON.parse(cut + closer);
          return cut + closer;
        } catch {
          /* continue */
        }
      }
    }
  }
  return text;
}

/** 从 JSON 字符串字段中提取字符串值（容错） */
export function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
