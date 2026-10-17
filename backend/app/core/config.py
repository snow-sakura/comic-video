"""AI 漫剧工坊后端 — 核心配置（环境变量 + 默认值）

配置优先级：DB (provider_settings) > 环境变量(.env) > 默认值

"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# 后端根目录（backend/）
# 本文件位于 backend/app/core/config.py → parent=core, parent.parent=app, parent³=backend
# 配置文件 .env 固定位于 backend/.env（仅后端使用）
SERVER_ROOT = Path(__file__).resolve().parent.parent.parent

# Agnes AI 统一 Base URL
AGNES_BASE = "https://apihub.agnes-ai.com/v1"


# ===== .env 大写键名 → 配置字段小写名 映射（加载前注入 os.environ）=====
# .env 沿用了历史大写键名（TEXT_API_KEY / DATABASE_URL …），而 pydantic 字段为小写。
# 在构造 Settings 前手动解析 .env 并注入 os.environ，保证真实 Key / 连接串生效。
#
# 注意：provider_* 字段是「配置开关」（选哪家），不应被 .env 强制，
# 否则数据库 provider_settings（可改）或默认值无法覆盖。故 provider 不进映射。
_ENV_KEY_TO_FIELD = {
    "DATABASE_URL": "database_url",
    "REDIS_URL": "redis_url",
    "STORAGE_DIR": "storage_dir",
    "MOCK_MODE": "mock_mode",
    "CORS_ORIGINS": "cors_origins",
    # 文本模型（LLM）
    "TEXT_API_KEY": "text_api_key",
    "TEXT_MODEL": "text_model",
    "TEXT_BASE_URL": "text_base_url",
    # 图像模型
    "IMAGE_API_KEY": "image_api_key",
    "IMAGE_MODEL": "image_model",
    "IMAGE_BASE_URL": "image_base_url",
    # 视频模型
    "VIDEO_API_KEY": "video_api_key",
    "VIDEO_MODEL": "video_model",
    "VIDEO_BASE_URL": "video_base_url",
    # TTS
    "TTS_ENGINE": "tts_engine",
    "TTS_API_KEY": "tts_api_key",
    "TTS_MODEL": "tts_model",
    "TTS_VOICE": "tts_voice",
    "TTS_BASE_URL": "tts_base_url",
    "TTS_PROVIDER_URL": "tts_base_url",
}


def _parse_env_file(path: Path) -> dict[str, str]:
    """解析 .env（KEY=VALUE，忽略注释/空行，去引号）"""
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
        val = line[eq + 1 :].strip()
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        out[key] = val
    return out


def _load_env_into_os() -> None:
    """把 backend/.env 与 .env.local 的值按映射注入 os.environ（不覆盖已存在的真实环境变量）

    加载顺序：.env → .env.local（后者覆盖前者，与设置页「同步写入 .env.local」配合）
    """
    merged: dict[str, str] = {}
    for f in (SERVER_ROOT / ".env", SERVER_ROOT / ".env.local"):
        merged.update(_parse_env_file(f))
    for key, val in merged.items():
        field = _ENV_KEY_TO_FIELD.get(key)
        if not field:
            continue
        # DATABASE_URL：若为同步 postgresql:// 形式，转换为 asyncpg 驱动
        if field == "database_url" and val.startswith("postgresql://"):
            val = val.replace("postgresql://", "postgresql+asyncpg://", 1)
        # 不覆盖进程已设置的值（真实环境变量优先）
        if field not in os.environ:
            os.environ[field] = val
        # 同时保留原始大写键（供其它代码直接读取）
        if key not in os.environ:
            os.environ[key] = val


_load_env_into_os()


class Settings(BaseSettings):
    """环境变量配置（.env 加载，大写键名）"""

    model_config = SettingsConfigDict(
        env_file=[str(SERVER_ROOT / ".env"), str(SERVER_ROOT / ".env.local")],
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ===== 数据库 / 队列 =====
    database_url: str = Field(
        default="postgresql+asyncpg://snow-sakura:@localhost:5432/comic_video",
        description="PostgreSQL 连接串（asyncpg 驱动）；可被 .env 的 DATABASE_URL 覆盖",
    )
    redis_url: str = Field(
        default="redis://localhost:6379", description="Redis 连接串（Celery）"
    )

    # ===== 存储 =====
    storage_dir: str = Field(
        default="./storage", description="素材/产物存储根目录（相对 backend/）"
    )

    # ===== Mock 模式 =====
    mock_mode: str = Field(
        default="auto",
        description="auto=有Key用真无Key自动mock | true=强制mock | false=强制真实",
    )

    # ===== 文本模型（LLM）=====
    text_provider: str = Field(
        default="agnes",
        description="agnes=Agnes AI(默认) | openai=OpenAI兼容通用 | mock",
    )
    text_api_key: str = Field(default="", description="Agnes API Key（平台控制台获取）")
    text_model: str = Field(
        default="agnes-3.0-flash",
        description="默认 agnes-3.0-flash（免费，512K 上下文）",
    )
    text_base_url: str = Field(default=AGNES_BASE, description="OpenAI 兼容 Base URL")

    # ===== 图像模型 =====
    image_provider: str = Field(
        default="agnes", description="agnes=Agnes AI(默认) | mock"
    )
    image_api_key: str = Field(default="", description="Agnes API Key")
    image_model: str = Field(
        default="agnes-image-2.5-flash",
        description="默认 agnes-image-2.5-flash（免费）",
    )
    image_base_url: str = Field(default=AGNES_BASE, description="OpenAI 兼容 Base URL")

    # ===== 视频模型 =====
    video_provider: str = Field(
        default="agnes", description="agnes=Agnes AI(默认，限流1次/分钟) | mock"
    )
    video_api_key: str = Field(default="", description="Agnes API Key")
    video_model: str = Field(
        default="agnes-video-2.5-flash",
        description="默认 agnes-video-2.5-flash（限时免费，720P）",
    )
    video_base_url: str = Field(default=AGNES_BASE, description="OpenAI 兼容 Base URL")

    # ===== TTS（留空 = Mock）=====
    tts_engine: str = Field(
        default="",
        description="edge-tts=微软免费(无Key) | mimo=小米MiMo-TTS(OpenAI兼容) | confucius4=本地 | voxcpm=本地开源 | 空=Mock",
    )
    tts_api_key: str = Field(default="", description="mimo 需要（小米 MiMo API Key）")
    tts_model: str = Field(
        default="",
        description="如 mimo-v2.5-tts / mimo-v2.5-tts-voiceclone（edge-tts 无需）",
    )
    tts_voice: str = Field(
        default="", description="默认音色，如 zh-CN-YunxiNeural（edge-tts）"
    )
    tts_base_url: str = Field(
        default="",
        description="mimo 默认 https://api.xiaomimimo.com/v1；也可指向 TokenDance 等 OpenAI 兼容网关",
    )

    # ===== Worker 并发 =====
    worker_concurrency_script: int = Field(default=1)
    worker_concurrency_image: int = Field(default=2)
    worker_concurrency_video: int = Field(default=1)
    worker_concurrency_audio: int = Field(default=2)
    worker_concurrency_compose: int = Field(default=1)

    # ===== 前端 CORS =====
    cors_origins: str = Field(
        default="http://localhost:3000,http://127.0.0.1:3000",
        description="允许跨域的前端源（逗号分隔）",
    )

    @property
    def storage_root(self) -> Path:
        p = Path(self.storage_dir)
        if not p.is_absolute():
            p = SERVER_ROOT / p
        return p.resolve()

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
