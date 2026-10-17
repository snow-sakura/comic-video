"""SQLAlchemy 模型（沿用旧 Prisma schema 设计，字段名转 snake_case；旧 schema 见 git 历史 prisma/schema.prisma）"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Index,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_cuid() -> str:
    """与 Prisma cuid() 等价的唯一 ID（前端按字符串处理）"""
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


# ========== 枚举值常量（与 Prisma schema 对齐） ==========

PROJECT_STATUS = (
    "DRAFT",
    "SCRIPTING",
    "ASSETING",
    "STORYBOARDING",
    "RENDERING",
    "DONE",
)
ASSET_TYPE = ("CHARACTER", "SCENE", "PROP", "STYLE")
ASSET_STATUS = ("DRAFTING", "REVIEWING", "APPROVED", "REJECTED")
TASK_TYPE = ("LLM", "IMAGE", "VIDEO", "TTS", "MUSIC", "SFX", "COMPOSE")
TASK_STATUS = ("QUEUED", "PROCESSING", "DONE", "FAILED", "REJECTED", "PAUSED")
SHOT_STATUS = (
    "PENDING",
    "PROMPT_READY",
    "IMAGE_GENERATING",
    "IMAGE_DONE",
    "IMAGE_FAILED",
    "VIDEO_GENERATING",
    "VIDEO_DONE",
    "VIDEO_FAILED",
    "VOICE_GENERATING",
    "VOICE_DONE",
    "VOICE_FAILED",
    "COMPOSED",
    "REJECTED",
)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    title: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(50), default="DRAFT")
    style: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    novel_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    novel_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    novel_meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    script_stage: Mapped[str | None] = mapped_column(
        String(50), nullable=True, default=None
    )
    episode_count: Mapped[int] = mapped_column(Integer, default=6)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    scripts: Mapped[list["Script"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )
    characters: Mapped[list["Character"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )
    scenes: Mapped[list["Scene"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )
    assets: Mapped[list["Asset"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )
    episodes: Mapped[list["Episode"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )
    tasks: Mapped[list["GenTask"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (
        Index("ix_projects_status", "status"),
        Index("ix_projects_updated_at", "updated_at"),
    )


class Script(Base):
    __tablename__ = "scripts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    project: Mapped["Project"] = relationship(back_populates="scripts")
    logline: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    content: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="draft")
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class Character(Base):
    __tablename__ = "characters"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    project: Mapped["Project"] = relationship(back_populates="characters")
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(50))
    gender: Mapped[str | None] = mapped_column(String(20), nullable=True)
    appearance: Mapped[dict] = mapped_column(JSONB)
    personality: Mapped[dict] = mapped_column(JSONB)
    costume: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    ref_image_ids: Mapped[list] = mapped_column(JSONB, default=list)
    voice_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    voice_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="DRAFTING")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class Scene(Base):
    __tablename__ = "scenes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    project: Mapped["Project"] = relationship(back_populates="scenes")
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    mood: Mapped[str | None] = mapped_column(String(200), nullable=True)
    ref_image_ids: Mapped[list] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(50), default="DRAFTING")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    project: Mapped["Project"] = relationship(back_populates="assets")
    type: Mapped[str] = mapped_column(String(50))
    name: Mapped[str] = mapped_column(String(200))
    image_ids: Mapped[list] = mapped_column(JSONB, default=list)
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="DRAFTING")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (Index("ix_assets_project_type", "project_id", "type"),)


class PipelineControl(Base):
    """流水线全局控制（单行，id 恒为 1）"""

    __tablename__ = "pipeline_controls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    paused: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class Episode(Base):
    __tablename__ = "episodes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    project: Mapped["Project"] = relationship(back_populates="episodes")
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    hook_end: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="draft")
    final_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    shots: Mapped[list["Shot"]] = relationship(
        back_populates="episode", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (
        UniqueConstraint("project_id", "number", name="uq_episodes_project_number"),
    )


class Shot(Base):
    __tablename__ = "shots"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    episode_id: Mapped[str] = mapped_column(
        ForeignKey("episodes.id", ondelete="CASCADE"), index=True
    )
    episode: Mapped["Episode"] = relationship(back_populates="shots")
    sequence: Mapped[int] = mapped_column(Integer)
    scene_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    scene_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    camera: Mapped[dict] = mapped_column(JSONB)
    action: Mapped[str | None] = mapped_column(Text, nullable=True)
    dialog: Mapped[str | None] = mapped_column(Text, nullable=True)
    dialog_char: Mapped[str | None] = mapped_column(String(500), nullable=True)
    dialog_emotion: Mapped[str | None] = mapped_column(String(100), nullable=True)
    duration: Mapped[float] = mapped_column(Float, default=5.0)
    prompt7: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    final_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    ref_images: Mapped[list] = mapped_column(JSONB, default=list)
    image_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    video_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    voice_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    subtitle_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="PENDING")
    retries: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (Index("ix_shots_episode_sequence", "episode_id", "sequence"),)


class ProviderSetting(Base):
    __tablename__ = "provider_settings"

    key: Mapped[str] = mapped_column(String(300), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class PromptTemplate(Base):
    __tablename__ = "prompt_templates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    key: Mapped[str] = mapped_column(String(100))
    scope: Mapped[str] = mapped_column(String(20), default="global")
    project_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str] = mapped_column(String(300))
    template: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "key", "scope", "project_id", name="uq_prompt_templates_key_scope_project"
        ),
        Index("ix_prompt_templates_scope_project", "scope", "project_id"),
    )


class GenTask(Base):
    __tablename__ = "gen_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_cuid)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True
    )
    project: Mapped["Project | None"] = relationship(back_populates="tasks")
    label: Mapped[str | None] = mapped_column(String(500), nullable=True)
    type: Mapped[str] = mapped_column(String(50))
    provider: Mapped[str] = mapped_column(String(100))
    model: Mapped[str] = mapped_column(String(200))
    ref_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="QUEUED")
    tier: Mapped[str] = mapped_column(String(10), default="free")
    provider_task_id: Mapped[str | None] = mapped_column(String(300), nullable=True)
    input: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        Index("ix_gen_tasks_status", "status"),
        Index("ix_gen_tasks_project_status", "project_id", "status"),
    )
