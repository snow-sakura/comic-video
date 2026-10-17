# SPEC：生成可靠性修复 + 免费/付费模型队列策略 + 逐集串行流水线 + 前端优化

状态：已废弃（其内容被 `docs/specs/2026-10-16-生成调度与并发优化-spec.md` 取代，后者已实现并通过验收）
日期：2026-10-16

## 1. 背景与问题

启动后生成漫剧的各类结果大量「失败 / 丢失 / 不完整」。代码梳理定位出以下根因：

| # | 问题 | 根因位置 |
|---|------|----------|
| P1 | `/health` 404，健康检查缺失，前端/脚本探测失败 | `app/main.py` 未注册 healthz |
| P2 | 重启后所有 QUEUED/PROCESSING 一律转 PAUSED，且 Redis 队列被 drain，旧任务只能手动重试，表现为"任务丢失" | `app/queue.py: pause_stuck_tasks / drain_queues` |
| P3 | 任务失败后无自动重试与状态推送，前端看不到失败原因 | `workers/tasks.py` 各 handler |
| P4 | 队列并发静态固定，无法按模型 free/paid 区分 | `app/queue.py QUEUE_DEFS` |
| P5 | 多集任务可同时进入 video/compose，无"上一集全部完成才进入下一集"的门控 | `api/projects_detail.py` 批量入队处 |
| P6 | 一集 compose 完成后不自动推进下一集 | 无该逻辑 |

## 2. 需求

R1 修复生成结果失败/丢失/不完整（P1–P3）。
R2 队列按模型计费档位分流：**免费模型 → 单任务串行**（并发=1）；**付费模型 → 多并行进程**（并发=N，可配置）。
R3 逐集串行：生成视频时，第 N 集全部镜头（图→视频→音频）完成并合成成功后，才自动开始第 N+1 集的视频任务；任一集失败则停下等待人工处理/重试。
R4 前端显示优化：任务状态、失败原因、逐集进度清晰可见。

## 3. 方案设计

### 3.1 队列策略（R2）

- `providers/catalog.py` 已带 `tags: ["free"|"paid"]`，新增工具函数 `get_model_tier(kind, model_id) -> "free"|"paid"`。
- Celery 按模型档位拆分队列：`video.free` 与 `video.paid`（image 同理）。
  - `free` 队列 worker 并发恒为 1（Agnes 免费档限流 1 次/分）。
  - `paid` 队列 worker 并发默认 3，可由 `WORKER_CONCURRENCY_VIDEO_PAID` 覆盖。
- `enqueue_gen_task(queue_name, ...)` 改为 `enqueue_gen_task(kind, tier, ...)`，路由到 `{kind}.{tier}`；任务入队时把模型档位写入 GenTask（新字段 `tier`，alembic 迁移 0002）。
- 启动脚本 `run_worker` 起两组 worker 进程：free(1) + paid(N)。

### 3.2 逐集串行门控（R3）

- 新增 `Episode.status` 流转：`PENDING → SCRIPT_DONE → PRODUCING → COMPOSED → FAILED`。
- 入队规则：一次只允许一集处于 `PRODUCING`。`POST /projects/{id}/produce`（新端点，或复用现有批量视频入口）只对"第一个未完成集"入队。
- 完成回调：`compose_task` 成功后调用 `advance_episode(db, project_id)` —— 找下一集，若剧本/分镜齐备则自动入队该集 image→video→audio 链；全部集完成则项目标记 `DONE`。
- 失败：该集镜头/任务 FAILED 时 Episode 置 `FAILED`，流水线暂停，前端提示重试（重试成功后继续 advance）。
- `PipelineControl.paused` 语义保留：暂停时不自动 advance。

### 3.3 可靠性修复（R1）

- 注册 `GET /healthz`（检查 DB + Redis，返回 200/503）。
- 重启不再默认丢弃在途任务：保留 `pause_stuck_tasks` 但新增 `POST /api/pipeline {action:"resume_all"}` 一键把 PAUSED 任务重新入队（按原始 payload 重放）。
- 各 handler 异常统一 `except → _mark_failed(error 摘要) → 任务可重试`，video 429 走现有 `_requeue_self` 延迟重试（已有，补 image/audio 同款）。
- GenTask 失败时写入结构化 error（阶段 + provider 返回摘要），前端直接展示。

### 3.4 前端优化（R4）

- Tasks 页：按集分组显示进度条（镜头图/视频/音频/合成 各阶段计数），失败任务展示错误摘要与「重试」按钮。
- Project 页：新增「逐集生产」面板——每集状态徽标（待生产/生产中/已完成/失败），当前集高亮；提供「从第 N 集开始自动生产」入口。
- 轮询已有 `/api/projects/{id}` 快照，补充返回 `episodes[].status` 与当前生产集。

## 4. 实施顺序

1. M1 可靠性：healthz + resume_all + 失败错误摘要（改动小，先落）。
2. M2 档位路由：tier 工具 + 队列拆分 + 迁移 0002 + worker 启动改造。
3. M3 逐集串行：Episode.status + advance_episode + compose 回调 + produce 端点。
4. M4 前端：任务分组/逐集面板/错误展示。
5. M5 验证：pytest 后端管线单测（mock provider）+ 手动起服务冒烟。

## 5. 验收标准

- [ ] 启动后 `/healthz` 返回 200。
- [ ] 免费模型选定时 video/image 任务并发=1；付费模型选定时并发≥2（env 可调）。
- [ ] 6 集项目自动生产时，任意时刻只有一集处于 PRODUCING，集 N 合成完成才启动集 N+1。
- [ ] 单镜头失败：该集标 FAILED 并停住；重试成功后流水线继续。
- [ ] 前端能看到每集进度与失败原因。
