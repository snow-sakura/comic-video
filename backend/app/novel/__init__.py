"""小说解析工具：分章、统计、启发式角色提取（Mock/无Key时的回退）"""

from __future__ import annotations

import re

CHAPTER_RE = re.compile(
    r"^\s*(?:第\s*[0-9一二三四五六七八九十百千万零〇]+\s*[章回节卷话]|Chapter\s+\d+|CHAPTER\s+\d+)\s*[：:.\s]*(.*)$"
)


class NovelMeta:
    def __init__(
        self, title: str | None, chapters: list[dict], char_count: int, word_count: int
    ):
        self.title = title
        self.chapters = chapters  # [{index, title, start, end}]
        self.char_count = char_count
        self.word_count = word_count

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "chapters": self.chapters,
            "charCount": self.char_count,
            "wordCount": self.word_count,
        }


def parse_novel(text: str) -> NovelMeta:
    """按章节标题切分小说文本"""
    lines = text.split("\n")
    chapters: list[dict] = []
    current: dict | None = None

    for i, line in enumerate(lines):
        m = CHAPTER_RE.match(line)
        if m:
            if current:
                end = (
                    sum(len(l) + 1 for l in lines[current["start_line"] : i])
                    + current["start"]
                )
                chapters.append(
                    {
                        "index": len(chapters) + 1,
                        "title": current["title"] or f"第{len(chapters) + 1}章",
                        "start": current["start"],
                        "end": end,
                    }
                )
            current = {
                "title": m.group(1).strip() if m.group(1) else "",
                "start": sum(len(l) + 1 for l in lines[:i]),
                "start_line": i,
            }
    if current:
        chapters.append(
            {
                "index": len(chapters) + 1,
                "title": current["title"] or f"第{len(chapters) + 1}章",
                "start": current["start"],
                "end": len(text),
            }
        )

    if not chapters:
        chapters.append({"index": 1, "title": "全文", "start": 0, "end": len(text)})

    word_count = len(re.findall(r"[\u4e00-\u9fa5]", text))
    return NovelMeta(
        title=None, chapters=chapters, char_count=len(text), word_count=word_count
    )


def chapter_text(meta: NovelMeta, text: str, index: int) -> str:
    """提取第 index 章（1-based）的文本"""
    for c in meta.chapters:
        if c["index"] == index:
            return text[c["start"] : c["end"]]
    return text


def chapters_digest(
    meta: NovelMeta, text: str, per_chapter: int = 800, max_chapters: int = 12
) -> str:
    """章节列表 → 摘要文本（每章前 N 字符，供 LLM 上下文）"""
    out = []
    for c in meta.chapters[:max_chapters]:
        body = re.sub(r"\s+", " ", chapter_text(meta, text, c["index"])[:per_chapter])
        out.append(f"【第{c['index']}章 {c['title']}】{body}")
    return "\n".join(out)


# ========== 启发式角色提取（回退方案） ==========

SURNAMES = list(
    "李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹"
    "袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚"
    "谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔"
    "贺赖龚文夜冷花柳云风雪霜星璃澈"
)

GROUP_SUFFIX_RE = re.compile(r"^[家门派帮族殿阁队部处司]$")
NON_NAME_WORDS = {
    "任务",
    "方式",
    "方法",
    "意思",
    "关系",
    "问题",
    "时候",
    "地方",
    "事情",
    "东西",
    "结果",
    "情况",
    "条件",
    "能力",
    "机会",
    "过程",
    "内容",
    "要求",
    "规定",
    "责任",
    "态度",
    "状态",
    "信息",
    "数据",
    "文件",
    "知识",
    "技术",
    "方案",
    "意见",
    "建议",
    "模式",
    "系统",
    "平台",
    "产品",
    "服务",
    "功能",
    "接口",
    "组件",
    "样式",
    "框架",
    "版本",
    "配置",
    "参数",
    "异常",
    "错误",
    "警告",
    "优化",
    "操作",
    "时间",
    "地点",
    "人物",
    "事件",
    "世界",
    "社会",
    "国家",
    "城市",
    "学校",
    "公司",
    "医院",
    "市场",
    "原因",
    "目的",
    "目标",
    "计划",
    "安排",
    "准备",
    "开始",
    "结束",
    "继续",
    "完成",
    "成功",
    "失败",
    "明白",
    "知道",
    "觉得",
    "认为",
    "希望",
    "需要",
    "想要",
    "决定",
    "发现",
    "感觉",
    "想法",
    "心情",
}
STOP_CHARS = "的了着呢吗啊吧呀嘛哦嗯"


def heuristic_characters(text: str) -> list[dict]:
    """从文本中启发式提取人物（统计出现频次）"""
    counts: dict[str, int] = {}
    body = re.sub(r"\s+", "", text)
    for i in range(len(body) - 1):
        a, b = body[i], body[i + 1]
        if a not in SURNAMES or not re.match(r"[\u4e00-\u9fa5]", b):
            continue
        two = a + b
        counts[two] = counts.get(two, 0) + 1
        c = body[i + 2] if i + 2 < len(body) else ""
        if re.match(r"[\u4e00-\u9fa5]", c) and c not in STOP_CHARS:
            three = a + b + c
            counts[three] = counts.get(three, 0) + 1

    def role_for(idx: int) -> str:
        if idx == 0:
            return "protagonist"
        if idx == 1:
            return "supporting"
        if idx <= 3:
            return "antagonist"
        return "utility"

    results = []
    for name, n in sorted(counts.items(), key=lambda x: -x[1]):
        if n < 3:
            continue
        if len(name) == 2 and GROUP_SUFFIX_RE.match(name[1]):
            continue
        if len(name) == 2 and name in NON_NAME_WORDS:
            continue
        if len(results) >= 12:
            break
        results.append(
            {
                "name": name,
                "role": role_for(len(results)),
                "gender": "unknown",
                "appearance": {
                    "hair": "待定（建议：深色中长发）",
                    "costume": "待定（建议：现代日常服饰）",
                    "facialMarkers": "待定",
                    "body": "待定",
                    "style": "待定",
                },
                "personality": {
                    "habits": "待定",
                    "emotionalReactions": "待定",
                    "speechStyle": "待定",
                    "psychology": "待定",
                },
                "mentions": n,
            }
        )
    return results
