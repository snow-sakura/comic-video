/**
 * 小说解析工具：分章、统计、启发式角色提取（Mock/无Key时的回退）
 */

export interface NovelChapter {
  index: number; // 1-based
  title: string;
  start: number; // 字符偏移
  end: number; // 字符偏移（不含）
}

export interface NovelMeta {
  title?: string;
  chapters: NovelChapter[];
  charCount: number;
  wordCount: number;
}

const CHAPTER_RE =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百千万零〇]+\s*[章回节卷话]|Chapter\s+\d+|CHAPTER\s+\d+)\s*[：:.\s]*(.*)$/;

/** 按章节标题切分小说文本 */
export function parseNovel(text: string): NovelMeta {
  const lines = text.split(/\r?\n/);
  const chapters: NovelChapter[] = [];
  let current: { title: string; start: number; startLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(CHAPTER_RE);
    if (m) {
      if (current) {
        const end = lines.slice(current.startLine, i).join("\n").length + current.start;
        chapters.push({
          index: chapters.length + 1,
          title: current.title || `第${chapters.length + 1}章`,
          start: current.start,
          end,
        });
      }
      current = { title: m[1].trim() || "", start: lines.slice(0, i).join("\n").length, startLine: i };
    }
  }
  if (current) {
    const end = text.length;
    chapters.push({
      index: chapters.length + 1,
      title: current.title || `第${chapters.length + 1}章`,
      start: current.start,
      end,
    });
  }

  // 无章节标题 → 整体一章
  if (chapters.length === 0) {
    chapters.push({ index: 1, title: "全文", start: 0, end: text.length });
  }

  const wordCount = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return { chapters, charCount: text.length, wordCount };
}

/** 提取第 index 章（1-based）的文本 */
export function chapterText(meta: NovelMeta, text: string, index: number): string {
  const ch = meta.chapters.find((c) => c.index === index);
  if (!ch) return text;
  return text.slice(ch.start, ch.end);
}

/** 章节列表 → 摘要文本（每章前 N 字符，供 LLM 上下文） */
export function chaptersDigest(meta: NovelMeta, text: string, perChapter = 800, maxChapters = 12): string {
  const list = meta.chapters.slice(0, maxChapters);
  return list
    .map((c) => {
      const body = chapterText(meta, text, c.index).slice(0, perChapter).replace(/\s+/g, " ");
      return `【第${c.index}章 ${c.title}】${body}`;
    })
    .join("\n");
}

// ========== 启发式角色提取（回退方案） ==========

export interface HeuristicCharacter {
  name: string;
  role: "protagonist" | "supporting" | "antagonist" | "utility";
  appearance: Record<string, string>;
  personality: Record<string, string>;
  mentions: number;
}

/** 常见中文姓氏，用于识别人物名 */
const SURNAMES = [
  "李", "王", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "胡", "朱", "高", "林",
  "何", "郭", "马", "罗", "梁", "宋", "郑", "谢", "韩", "唐", "冯", "于", "董", "萧", "程", "曹",
  "袁", "邓", "许", "傅", "沈", "曾", "彭", "吕", "苏", "卢", "蒋", "蔡", "贾", "丁", "魏", "薛",
  "叶", "阎", "余", "潘", "杜", "戴", "夏", "钟", "汪", "田", "任", "姜", "范", "方", "石", "姚",
  "谭", "廖", "邹", "熊", "金", "陆", "郝", "孔", "白", "崔", "康", "毛", "邱", "秦", "江", "史",
  "顾", "侯", "邵", "孟", "龙", "万", "段", "雷", "钱", "汤", "尹", "黎", "易", "常", "武", "乔",
  "贺", "赖", "龚", "文", "夜", "冷", "花", "柳", "云", "风", "月", "雪", "霜", "星", "璃", "澈",
];

/** 从文本中启发式提取人物（统计出现频次） */
export function heuristicCharacters(text: string): HeuristicCharacter[] {
  const counts = new Map<string, number>();
  const body = text.replace(/\s+/g, "");
  const chars = [...body];
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i];
    const b = chars[i + 1];
    if (!SURNAMES.includes(a)) continue;
    // 候选名：单字名或双字名（第二个字不为常见虚词/标点）
    if (/[\u4e00-\u9fa5]/.test(b)) {
      const two = a + b;
      counts.set(two, (counts.get(two) ?? 0) + 1);
      // 三字名（复姓或 AB名+第三字）
      const c = chars[i + 2];
      if (/[\u4e00-\u9fa5]/.test(c) && !"的了着呢吗啊吧呀嘛哦嗯".includes(c)) {
        const three = a + b + c;
        counts.set(three, (counts.get(three) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3) // 至少出现 3 次
    .sort((x, y) => y[1] - x[1])
    .slice(0, 12)
    .map(([name, mentions], i) => ({
      name,
      role: (i === 0 ? "protagonist" : i === 1 ? "supporting" : i <= 3 ? "antagonist" : "utility") as HeuristicCharacter["role"],
      appearance: {
        hair: "待定（建议：深色中长发）",
        costume: "待定（建议：现代日常服饰）",
        facialMarkers: "待定",
        body: "待定",
        style: "待定",
      },
      personality: {
        habits: "待定",
        emotionalReactions: "待定",
        speechStyle: "待定",
        psychology: "待定",
      },
      mentions,
    }));
}
