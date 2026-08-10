# AI漫剧创作平台 — 实施计划 (IMPLEMENTATION-PLAN)

> 版本: v1.0 | 日期: 2026-08-10 | 总工期: 约4-5周（6里程碑）

## 里程碑总览

| # | 里程碑 | 内容 | 验收标准 | 状态 |
|---|---|---|---|---|
| M0 | 基础设施 | 脚手架/DB/队列/适配器/UI骨架 | 全流程 mock 可跑通 | ⬜ |
| M1 | 剧本工坊 | 小说上传+3 Agent | 小说→剧本定稿 | ⬜ |
| M2 | 资产工厂 | 定妆+场景+资产库 | 角色卡→定妆照入库 | ⬜ |
| M3 | 分镜车间 | 拆分镜+7维提示词+逐镜图 | 剧本→分镜墙 | ⬜ |
| M4 | 视频合成厂 | 可灵+TTS+BGM+FFmpeg | 分镜→成片导出 | ⬜ |
| M5 | 集成打磨 | 流水线串联+费用+导出+文档 | 一键全流程 | ⬜ |

## M0 基础设施（Step 1-6）

- [ ] M0-0 四份正式文档（PRD/ARCHITECTURE/TECH-STACK/IMPLEMENTATION-PLAN）
- [ ] M0-1 Next.js 16 + TS + Tailwind v4 脚手架，`create-next-app`
- [ ] M0-2 PostgreSQL 建库 `comic_video` + Prisma Schema + `prisma migrate dev`
- [ ] M0-3 供应商适配器层：`types.ts` / `registry.ts` / 各 Provider（含 mock 实现）
- [ ] M0-4 BullMQ：5 队列 + Worker 进程 + SSE 事件推送
- [ ] M0-5 项目 CRUD + 工作台四步 Tabs 骨架 + 设置页（API Key 配置）

## M1 剧本工坊（Step 7-11）

- [ ] M1-1 小说上传/粘贴 + 章节切分与清洗（服务端解析 .txt/.md）
- [ ] M1-2 Agent: logline（核心梗概一句话）
- [ ] M1-3 Agent: character（角色三维护刻画，Zod Schema 校验）
- [ ] M1-4 Agent: script（剧本结构化：分场/钩子/集尾悬念/心理转动作台词）
- [ ] M1-5 剧本工坊 UI：流式输出 + 编辑 + 重新生成 + 版本

## M2 资产工厂（Step 12-15）

- [ ] M2-1 Agent: asset-extractor（角色/场景/道具清单）
- [ ] M2-2 定妆照生成器（Seedream 组图模式 4-6 张 + 多参考图）
- [ ] M2-3 场景空镜生成 + 风格锁定（全局风格参考图）
- [ ] M2-4 资产库 UI：资产卡/入库/精选/编辑

## M3 分镜车间（Step 16-19）

- [ ] M3-1 Agent: storyboard（分镜拆解：角度/运镜/构图/台词/时长）
- [ ] M3-2 prompt-builder（提示词 7 维生成 + 资产参考注入）
- [ ] M3-3 逐镜图像生成器（一镜一任务，携带角色/场景/风格参考）
- [ ] M3-4 分镜墙 UI：时间轴 + 逐格状态 + 单镜重生成/调校

## M4 视频合成厂（Step 20-23）

- [ ] M4-1 可灵 3.0 Omni 适配器（异步+回调+轮询）+ Vidu 备选
- [ ] M4-2 CosyVoice 适配器 + 角色音色映射 + 长文本分段
- [ ] M4-3 音效/BGM 匹配引擎（情绪标签 → 可灵音频/BGM库）
- [ ] M4-4 FFmpeg 合成管线（画面+配音+字幕+转场）+ 成片导出页

## M5 集成打磨（Step 24-26）

- [ ] M5-1 端到端流水线串联（一键全流程/分步手动）
- [ ] M5-2 费用追踪面板（项目/集/镜头三级）+ 项目导出导入
- [ ] M5-3 README + 操作手册 + 验收测试

## 执行原则

1. **每步完成即验证**：lint + typecheck + 运行冒烟
2. **Mock 优先**：无 API Key 时全流程用 mock 适配器跑通，接入真实 Key 即换
3. **逐镜生成**：系统设计层面不提供九宫格批量
4. **文档同步**：API 变更即时更新本计划与 ARCHITECTURE.md
