# AI 漫剧工坊

小说 → 剧本 → 资产 → 分镜 → 视频 的 AI 漫剧创作流水线（单用户本地工具，纯云端 API + 国内生态）。

> 在线体验：仓库内 `demo/index.html`（纯静态单文件，零依赖零数据库，数据为内置样例）。克隆后直接用浏览器打开该文件，或在本地任意静态服务器（如 `npx serve demo`）下访问，即可完整体验四步流水线交互。

## 界面特性

- 浅色日式治愈主题（米白纸感底 + 抹茶绿主色，Tailwind v4 `@theme` 色板整体映射，全站统一）
- 设置面板五分组 TABS（通用 / 文本 / 图像 / 视频 / 音频），未保存的变更带分组角标，一键「保存 N 项变更」
- 项目工作台四步引导（01 剧本 → 02 资产 → 03 分镜 → 04 合成），顶部步骤条 + 底部前后翻页，任务与费用面板可折叠

## 技术栈

- Next.js 16（应用路由）+ React 19 + TypeScript + Tailwind CSS v4
- PostgreSQL 18 + Prisma 7（驱动适配器）
- Redis + BullMQ（任务队列：剧本 / 图像 / 视频 / 配音 / 合成（含配音与背景音乐混音））
- AI 供应商（默认智谱，全部可插拔）：文本 智谱 GLM / DeepSeek / 豆包；图像 智谱 CogView / Seedream 5.0；视频 智谱 CogVideoX / 可灵；配音 Mock / Edge-TTS / CosyVoice
- 模拟模式：未配置密钥时全流程自动降级为占位实现，保证可跑通

## 本地启动

前置：PostgreSQL（库名 `comic_video`）、Redis（默认 localhost:6379）、ffmpeg。
脚本会自动检查并尝试通过 `brew services` 启动缺失的服务，Prisma 迁移也会自动执行。

```bash
# 1. 安装依赖
npm install

# 2. 一键启动（自动: 检查 .env / Redis / PostgreSQL / 数据库迁移 / 启动网页+队列）
npm run dev:all        # 或 ./scripts/dev.sh
```

- 网页界面: http://localhost:3000（`npm run dev` 单独启动）
- 任务队列: 随 dev:all 自动后台运行（`npm run worker` 可单独启动）
- Ctrl+C 统一退出全部进程
- 密钥可留空，自动走模拟模式（Mock）全流程演示

## 脚本

```bash
npm run dev:all                  # 一键启动（网页 + 队列 Worker）
npm run dev                      # 仅网页界面
npm run worker                   # 仅任务队列工作进程
npm run check:env                # 环境配置体检
npm run test:providers           # 适配器层集成测试（模拟模式）
npm run test:concurrency         # 队列并发验证
npm run test:graceful            # Worker 优雅重启验证
npm run monitor                  # 队列实时监控
npm run metrics                  # Prometheus 指标导出
```

## 测试与质量

```bash
npx tsc --noEmit                 # 类型检查（0 错误）
npm run lint                     # ESLint
npx vitest run                   # 单元测试（适配器/成本/解析等 56 用例）
```

## 目录结构

```
prisma/            # 数据模型与迁移
src/lib/
  db.ts            # Prisma 单例（PrismaPg 适配器）
  env.ts           # 环境变量加载（.env + .env.local）
  storage.ts       # 本地文件存储（storage/ 分类目录）
  novel/parser.ts  # 小说解析（分章/摘要/启发式角色提取）
  agents/          # 剧本工坊三智能体（大语言模型 + 启发式回退）
    prompts.ts     #   智能体提示词（角色提炼/大纲/分集剧本）
    json.ts        #   LLM JSON 容错解析
    index.ts       #   角色提炼 / 分集大纲 / 分集剧本
  assets/prompts.ts # 资产工厂设计稿提示词（定妆照/空镜/道具 + 风格锚点）
  storyboard/     # 分镜车间（场景→镜头 + 7维提示词组装 + 资产引用）
  compose/        # 视频合成厂（微动态提示词 + ffmpeg 逐镜合成 / 拼接 / 背景音乐混音）
  providers/       # 供应商适配器层
    types.ts       # 统一契约（LLM/图像/视频/配音/音乐/音效）
    settings.ts    # 配置中心（数据库 > 环境变量 > 默认值）
    llm/ image/ video/ tts/ music/ sfx/   # 各供应商实现 + 模拟实现
    registry.ts    # 按配置路由聚合
  queue/           # BullMQ（队列 / 工作进程 / 连接）
src/app/api/       # 路由处理器（项目 / 小说 / 剧本 / 资产 / 分镜 / 合成 / 文件 / 设置）
src/app/projects/[id]  # 四步流水线工作台
src/components/script/ScriptWorkbench.tsx  # 剧本工坊工作台
src/components/asset/AssetWorkbench.tsx   # 资产工厂工作台
src/components/storyboard/StoryboardWorkbench.tsx  # 分镜车间工作台
src/components/compose/ComposeWorkbench.tsx        # 视频合成厂工作台
src/components/SettingsPanel.tsx          # 设置面板（五分组 TABS）
demo/index.html   # 纯静态在线体验 demo（浏览器直接打开即可，零依赖零数据库）
```

## 里程碑

- [x] M0 基础设施：文档 / 脚手架 / 数据库 / 供应商适配器 / 任务队列 / 项目增删改查 + 工作台界面
- [x] M1 剧本工坊：上传小说 → 提炼角色 → 分集大纲 → 逐集剧本（三智能体 + 启发式回退）
- [x] M2 资产工厂：角色定妆照 / 场景空镜 / 道具设计稿 + 一致性锁定（锁定后作为分镜参考图）
- [x] M3 分镜车间：AI 分镜（场景→镜头）→ 7 维提示词（引用锁定资产）→ 批量出图 → 审阅重出
- [x] M4 视频合成厂：视频引擎（智谱/可灵）/ 配音 / 背景音乐混音 / ffmpeg 逐镜合成导出
- [x] M5 集成打磨：全流程串联端到端 / 并发冲突静默接管 / 状态覆盖修复 / 按钮文案修正
- [x] P1 体验增强：视频质量校验 / 费用估算 / 视频重生与对白替换 / 手动分镜 / 音频试听 / 导出与分享 / 任务中心与失败重试 / 一键启动（`npm run dev:all`）
- [x] P2 提示词工程与 UI 打磨：三智能体提示词全面增强（情绪曲线 / TTS 友好对白 / 光线-动作-环境-景别结构 / 情绪色板 / 扩充光线匹配）；浅色日式治愈主题；设置五分组 TABS；项目四步引导 TABS；纯静态在线 demo

详见 `docs/`。