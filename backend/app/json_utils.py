"""LLM 结构化输出容错解析"""

from __future__ import annotations

import json
import re

# 剥离 markdown 代码块围栏
_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```")


def safe_parse_json(raw: str | None):
    """从 LLM 响应中提取 JSON（剥离 markdown fence、截断修复），失败返回 None"""
    if not raw:
        return None
    text = raw.strip()
    m = _FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    # 找最外层 { ... }
    start = text.find("{")
    if start == -1:
        return None
    end = text.rfind("}")
    if end <= start:
        return None
    candidate = text[start : end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        # 截断修复：从后往前补全括号
        fixed = _truncate_fix(candidate)
        if fixed is not None:
            return fixed
        return None


def _truncate_fix(candidate: str):
    """修复被截断的 JSON：逐层补全尾部括号直到可解析"""
    # 尝试直接补全常见尾部
    for closer in ("}", "}", '"]', '"}', "}}", '"]}', "]}", "}]}"):
        try:
            return json.loads(candidate + closer)
        except json.JSONDecodeError:
            continue
    # 启发式：按括号栈补全
    stack = []
    in_str = False
    esc = False
    for ch in candidate:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch in "{[":
                stack.append(ch)
            elif ch == "}":
                if stack and stack[-1] == "{":
                    stack.pop()
            elif ch == "]":
                if stack and stack[-1] == "[":
                    stack.pop()
    suffix = "".join("}" if c == "{" else "]" for c in reversed(stack))
    if in_str:
        suffix = '"' + suffix
    try:
        return json.loads(candidate + suffix)
    except json.JSONDecodeError:
        return None


def as_record(v) -> dict:
    return v if isinstance(v, dict) else {}


def as_list(v) -> list:
    """JSONB list 字段（ref_image_ids/image_ids/refImages）安全取列表。

    注意：这些字段本身就是 list，过 as_record 会得到 {}（falsy）→ or [] 恒为空，
    导致参考图被静默丢弃，必须用本函数。
    """
    return list(v) if isinstance(v, list) else []


def as_string(v, fallback: str = "") -> str:
    if v is None:
        return fallback
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, dict):
        return json.dumps(v, ensure_ascii=False)
    return fallback


def as_string_array(v) -> list[str]:
    if isinstance(v, list):
        return [as_string(x) for x in v if as_string(x)]
    if isinstance(v, str):
        return [s.strip() for s in re.split(r"[,，、;；]", v) if s.strip()]
    return []
