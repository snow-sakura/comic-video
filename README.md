# AI 漫剧工坊

小说 → 剧本 → 资产 → 分镜 → 视频 的 AI 漫剧创作流水线（单用户本地工具，纯云端 API + 国内生态）。

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript + Tailwind CSS v4
- PostgreSQL 18 + Prisma 7（driver adapter）
- Redis + BullMQ（任务队列：script / image / video / TTS / compose（含配音/BGM 混音））
- AI 供应商：DeepSeek / 火山方舟（豆包 + Seedream 5.0）/ 可灵 3.0 Omni / 阿里百炼 CosyVoice
- Mock 模式：未配置 Key 时全流程自动降级为占位实现，保证可跑通

## 本地启动

前置：PostgreSQL（库名 `comic_video`）、Redis（默认 localhost:6379）。

```bash
# 1. 安装依赖
npm install

# 2. 数据库迁移
npx prisma migrate dev

# 3. 配置环境变量（Key 可留空，走 Mock 模式）
#    .env      → 非敏感配置（DATABASE_URL / REDIS_URL / STORAGE_DIR / MOCK_MODE）
#    .env.local → API Keys（DEEPSEEK_API_KEY / ARK_API_KEY / KLING_API_KEY / KLING_SECRET / DASHSCOPE_API_KEY）

# 4. 启动（两个终端）
npm run dev        # Web 界面（http://localhost:3000）
npm run worker     # 任务队列 Worker
```

## 脚本

```bash
npx tsx scripts/test-providers.ts  # 适配器层集成测试（mock）
npx tsx scripts/test-queue.ts     # 队列层集成测试（mock）
npx tsx scripts/worker.ts         # 单独启动 worker 进程
```

## 目录结构

```
prisma/            # 数据模型与迁移
src/lib/
  db.ts            # Prisma 单例（PrismaPg adapter）
  env.ts           # 环境变量加载（.env + .env.local）
  storage.ts       # 本地文件存储（storage/ 分类目录）
  novel/parser.ts  # 小说解析（分章/摘要/启发式角色提取）
  agents/          # 剧本工坊三 Agent（LLM + 启发式回退）
    prompts.ts     #   Agent Prompt（角色提炼/大纲/分集剧本）
    json.ts        #   LLM JSON 容错解析
    index.ts       #   runExtractCharacters / runGenerateOutline / runGenerateEpisode
  assets/prompts.ts # 资产工厂设计稿 prompt（定妆照/空镜/道具 + 风格锚点）
  storyboard/     # 分镜车间（场景→镜头 + 7维提示词组装 + 资产引用）
  compose/        # 视频合成厂（微动态提示词 + ffmpeg 逐镜合成 / concat / BGM 混音）
  providers/       # 供应商适配器层
    types.ts       # 统一契约（LLM/Image/Video/TTS/Music/SFX）
    settings.ts    # 配置中心（DB > env > 默认）
    llm/ image/ video/ tts/ music/ sfx/   # 各供应商实现 + Mock
    registry.ts    # 按配置路由聚合
  queue/           # BullMQ（queues / workers / connection）
src/app/api/       # Route Handlers（projects / novel / script-agent / assets / storyboard / compose / files / settings）
src/app/projects/[id]  # 四步流水线工作台
src/components/script/ScriptWorkbench.tsx  # 剧本工坊工作台
src/components/asset/AssetWorkbench.tsx   # 资产工厂工作台
src/components/storyboard/StoryboardWorkbench.tsx  # 分镜车间工作台
src/components/compose/ComposeWorkbench.tsx        # 视频合成厂工作台
```

## 里程碑

- [x] M0 基础设施：文档 / 脚手架 / 数据库 / 供应商适配器 / 任务队列 / 项目 CRUD + 工作台 UI
- [x] M1 剧本工坊：上传小说 → 提炼角色 → 分集大纲 → 逐集剧本（三 Agent + 启发式回退）
- [x] M2 资产工厂：角色定妆照 / 场景空镜 / 道具设计稿 + 一致性锁定（APPROVED 后作为分镜参考图）
- [x] M3 分镜车间：AI 分镜（场景→镜头）→ 7 维提示词（引用锁定资产）→ 批量出图 → 审阅重出
- [x] M4 视频合成厂：可灵微动态 / TTS 配音 / BGM 混音 / ffmpeg 逐镜合成导出
- [x] M5 集成打磨：全流程串联 e2e / 并发 409 静默接管 / 状态覆盖修复 / 按钮文案修正

详见 `docs/`。
