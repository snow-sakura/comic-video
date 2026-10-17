"""baseline: schema already exists (stamped, no-op)

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-14
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """空操作：基线。表结构已存在于库中（11 张 snake_case 表），
    后续架构变更通过 `alembic revision --autogenerate` 生成迁移。"""
    pass


def downgrade() -> None:
    """基线不可降级（空操作）。"""
    pass
