"""序列化器：ORM → camelCase JSON（与前端 Next.js 时代的接口契约对齐）"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any


def camelize(obj: Any) -> Any:
    """递归转 camelCase（dict key 与嵌套结构）"""
    if isinstance(obj, dict):
        return {k: camelize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [camelize(x) for x in obj]
    return obj


def snake_to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])


class ModelSerializer:
    """将 ORM 对象转为前端期望的 camelCase 字典（属性名 snake_case → camelCase）"""

    @staticmethod
    def serialize(obj: Any, extra: dict | None = None) -> dict:
        if obj is None:
            return extra or {}
        result: dict = {}
        for col in obj.__class__.__table__.columns:
            v = getattr(obj, col.name, None)
            if isinstance(v, datetime):
                v = v.isoformat()
            if isinstance(v, (dict, list)):
                try:
                    v = json.loads(json.dumps(v, default=str))
                except (TypeError, ValueError):
                    v = str(v)
            result[snake_to_camel(col.name)] = v
        if extra:
            result.update(extra)
        return result
