"""环境变量路由 — /api/env

GET /api/env — 读取 .env / .env.local 键值（敏感值脱敏）
用于设置页「供应商设置」展示各配置项来源。
"""

from __future__ import annotations

import re
from pathlib import Path
from fastapi import APIRouter

from app.core.config import SERVER_ROOT, get_settings

router = APIRouter()

SENSITIVE_RE = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASS|ACCESS)", re.IGNORECASE)


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    try:
        content = path.read_text()
    except OSError:
        return out
    for line in content.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        eq = line.find("=")
        if eq == -1:
            continue
        key = line[:eq].strip()
        value = line[eq + 1 :].strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        out[key] = value
    return out


def _mask(name: str, value: str) -> str:
    if not SENSITIVE_RE.search(name) or not value:
        return value
    if len(value) <= 4:
        return "****"
    return f"{value[:2]}****{value[-2:]}"


@router.get("/env")
async def get_env():
    settings = get_settings()
    # 配置文件仅在 backend/ 下（backend/.env 与 backend/.env.local）
    backend_dir = SERVER_ROOT
    files = []
    for fname, base in [
        (".env", backend_dir),
        (".env.local", backend_dir),
    ]:
        parsed = _parse_env_file(base / fname)
        files.append(
            {
                "file": f"{base.name}/{fname}",
                "vars": [
                    {
                        "key": k,
                        "value": _mask(k, v),
                        "sensitive": bool(SENSITIVE_RE.search(k)),
                    }
                    for k, v in parsed.items()
                ],
            }
        )
    return {"files": files}
