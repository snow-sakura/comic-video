"""Celery 应用（Redis broker，承接 5 类流水线任务）"""

from __future__ import annotations

from celery import Celery
from kombu import Queue
from app.core.config import get_settings

s = get_settings()

# 队列命名：compose 单队列；script/image/video/audio 按 free/paid 档位拆分
# （免费模型单任务串行消费，付费模型多并行进程消费，见 app/scheduler/tier.py）
QUEUE_NAMES = {
    "script.free": "script.free",
    "script.paid": "script.paid",
    "image.free": "image.free",
    "image.paid": "image.paid",
    "video.free": "video.free",
    "video.paid": "video.paid",
    "audio.free": "audio.free",
    "audio.paid": "audio.paid",
    "compose": "compose",
}

celery_app = Celery("comic_video")
celery_app.conf.update(
    broker_url=s.redis_url,
    result_backend=s.redis_url,
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Shanghai",
    enable_utc=False,
    # 任务失败重试
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    broker_connection_retry_on_startup=True,
    # 命名队列：与 enqueue_gen_task(queue=...) / Queue(name) 一一对应，
    # worker 启动时用 -Q script,image.free,image.paid,video.free,video.paid,audio,compose 选择性消费
    task_queues=[Queue(qname) for qname in QUEUE_NAMES.values()],
)

# 自动发现 workers 包内任务
celery_app.autodiscover_tasks(["workers"])
