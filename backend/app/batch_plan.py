"""worker 进程组计划 CLI — 供启动脚本消费（免费串行 / 付费并行）

用法（在 backend/ 目录执行）：

    python -m app.batch_plan              # JSON：档位 + 进程组计划
    python -m app.batch_plan --shell      # name|queues|csv|concurrency|pool 行（供 shell 消费）
    python -m app.batch_plan --summary    # 人类可读摘要
    python -m app.batch_plan --concurrency image  # 单能力付费并发数
"""

from __future__ import annotations

import json
import sys

from app.scheduler.tier import KINDS, get_paid_concurrency, get_status


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    status = get_status()

    if "--shell" in args:
        for g in status["groups"]:
            print(f"{g['name']}|{','.join(g['queues'])}|{g['concurrency']}|{g['pool']}")
        return 0

    if "--concurrency" in args:
        idx = args.index("--concurrency")
        if idx + 1 >= len(args):
            print("用法: --concurrency <kind>", file=sys.stderr)
            return 2
        kind = args[idx + 1]
        if kind not in KINDS:
            print(f"未知能力: {kind}（可选 {', '.join(KINDS)}）", file=sys.stderr)
            return 2
        print(get_paid_concurrency(kind))
        return 0

    if "--summary" in args:
        forced = status["forced"] or "auto"
        print(f"调度档位：{forced}（免费=单任务串行 / 付费=多进程并行）")
        for kind in KINDS:
            print(f"  {kind:<7} tier={status['tiers'][kind]}")
        print("  worker 进程组：")
        for g in status["groups"]:
            print(
                f"    {g['name']:<12} pool={g['pool']:<8} 并发={g['concurrency']} "
                f"队列={','.join(g['queues'])}"
            )
        print(f"  合计进程：{status['totalWorkers']}")
        return 0

    print(json.dumps(status, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
