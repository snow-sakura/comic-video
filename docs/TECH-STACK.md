# AI漫剧创作平台 — 技术选型表 (TECH-STACK)

> 版本: v1.0 | 日期: 2026-08-10 | 全部决策已与用户确认

## 1. 核心框架

| 领域 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 前端框架 | Next.js | 16.x | App Router, React 19, Server Actions |
| 语言 | TypeScript | 5.x | 全栈类型安全 |
| 样式 | Tailwind CSS | v4 | 原子化快速构建 |
| ORM | Prisma | 6.x | Schema 即文档，迁移工具成熟 |
| 任务队列 | BullMQ | 5.x | Redis 驱动，事件完备 |
| Redis 客户端 | ioredis | 5.x | BullMQ 官方依赖 |

## 2. AI 供应商（适配器层，全部国内直连）

### LLM
| Provider | 模型 | 用途 | 接入方式 |
|---|---|---|---|
| DeepSeek | deepseek-chat (V3.2) | 剧本创作：梗概/角色/剧本 | `@ai-sdk/deepseek` |
| 火山方舟 | doubao-seed-1-6 | 结构化任务：分镜/提示词/JSON | `@ai-sdk/openai` + baseURL `https://ark.cn-beijing.volces.com/api/v3` |

### 图像
| Provider | 模型 | 用途 | 端点 |
|---|---|---|---|
| 火山方舟 | doubao-seedream-5-0-pro | 定妆/场景/分镜图（多参考图+组图模式） | `POST https://ark.cn-beijing.volces.com/api/v3/images/generations` |
| 通义万相(备) | wanx-v2 | 备用图像 | DashScope |

### 视频
| Provider | 模型 | 用途 | 端点 |
|---|---|---|---|
| 可灵 Kling | kling-v3-0-omni 图生视频 | 主引擎（主体参考） | `https://api.klingai.com` (官方开放平台，Node SDK) |
| Vidu(备) | vidu-2 | 高速低成本备选 | Vidu API |

### TTS
| Provider | 模型 | 用途 | 接入方式 |
|---|---|---|---|
| 阿里百炼 | CosyVoice v2 | 主配音（多音色+声音复刻） | DashScope WebSocket/HTTP，`@alicloud/dashscope` |
| MiniMax(备) | Speech 2.8 | 备选配音 | MiniMax API |
| 小米(待确认) | - | 备选配音 | API 开放情况待核实 |

### 音频
| Provider | 能力 | 用途 |
|---|---|---|
| 可灵音频生成 API | 环境音效/氛围音 | 每镜音效生成 |
| BGM 素材库 | 免版权音乐（爱给网/YouTube Audio Library） | 按情绪标签匹配 |

## 3. 基础设施

| 组件 | 选型 | 备注 |
|---|---|---|
| PostgreSQL | 18.x (Homebrew 本机) | 元数据库 |
| Redis | 8.8 (Homebrew 本机) | 队列+事件 |
| 视频处理 | FFmpeg (系统 ffmpeg) | 合成/转场/字幕 |
| 文件存储 | 本地 `storage/` | 单用户无 S3 |
| 字体/UI | Geist + Tailwind 组件自研 | 无重型 UI 库 |

## 4. 关键依赖清单

```jsonc
{
  "dependencies": {
    "next": "^16", "react": "^19", "react-dom": "^19",
    "@prisma/client": "^6", "prisma": "^6",
    "bullmq": "^5", "ioredis": "^5",
    "ai": "^4", "@ai-sdk/deepseek": "^1", "@ai-sdk/openai": "^1",
    "zod": "^3", "nanoid": "^5"
  },
  "devDependencies": {
    "typescript": "^5", "tailwindcss": "^4", "@tailwindcss/postcss": "^4",
    "eslint": "^9", "eslint-config-next": "^16"
  }
}
```

## 5. 环境变量

见 `.env.example`（DATABASE_URL / REDIS_URL / DEEPSEEK_API_KEY / ARK_API_KEY / KLING_API_KEY / DASHSCOPE_API_KEY / STORAGE_DIR）。

## 6. 成本模型（估算）

| 环节 | 单价 | 单集(3分钟约40镜) |
|---|---|---|
| 图像 | Seedream 约 ¥0.05-0.15/张 | ¥2-5 |
| 视频 | 可灵 0.9-1.2积分/秒 (约¥1/5s镜) | ¥30-60 |
| TTS | CosyVoice 约 ¥2/万字 | ¥1-3 |
| LLM | DeepSeek ¥2/百万token | <¥1 |
| 合计 | | **¥40-70/集** |
