"""调度层：按模型计费档位（free / paid）决定队列拆分与 worker 进程组。

详见 docs/specs/2026-10-16-生成调度与并发优化-spec.md
"""

from app.scheduler.tier import (  # noqa: F401
    FREE_QUEUES,
    KINDS,
    PAID_DEFAULT,
    get_paid_concurrency,
    get_status,
    get_tier,
    get_tiers,
    get_worker_groups,
)

__all__ = [
    "FREE_QUEUES",
    "KINDS",
    "PAID_DEFAULT",
    "get_paid_concurrency",
    "get_status",
    "get_tier",
    "get_tiers",
    "get_worker_groups",
]
