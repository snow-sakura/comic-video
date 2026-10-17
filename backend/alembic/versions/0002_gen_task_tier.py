"""gen_tasks 增加 tier 字段（free/paid 模型档位，决定队列并发策略）

Revision ID: 0002_gen_task_tier
Revises: 0001_baseline
Create Date: 2026-10-16
"""

from alembic import op
import sqlalchemy as sa

revision: str = "0002_gen_task_tier"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "gen_tasks",
        sa.Column("tier", sa.String(length=10), nullable=False, server_default="free"),
    )


def downgrade() -> None:
    op.drop_column("gen_tasks", "tier")
