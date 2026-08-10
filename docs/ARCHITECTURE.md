# AI漫剧创作平台 — 架构文档 (ARCHITECTURE)

> 版本: v1.0 | 日期: 2026-08-10

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                   Next.js 16 全栈应用 (单用户本地)              │
│  ┌─────────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐ │
│  │① 剧本工坊   │→ │② 资产工厂  │→ │③ 分镜车间 │→ │④ 视频合成厂│ │
│  │ 3个LLM Agent│  │ Seedream  │  │ 分镜Agent │  │ 可灵 Omni │ │
│  │ 梗概/角色/  │  │ 5.0组图    │  │ 提示词7维 │  │ CosyVoice │ │
│  │ 剧本结构化  │  │ 多参考图   │  │ 逐镜生成  │  │ FFmpeg    │ │
│  └─────────────┘  └───────────┘  └──────────┘  └───────────┘ │
├─────────────────────────────────────────────────────────────┤
│  任务编排层: BullMQ 队列 (5队列) + 状态机 + Webhook + SSE     │
├─────────────────────────────────────────────────────────────┤
│  数据层: PostgreSQL (Prisma) + Redis (BullMQ/缓存) + storage/ │
├─────────────────────────────────────────────────────────────┤
│  供应商适配层: LLM / Image / Video / TTS / Music / SFX       │
│  DeepSeek 豆包 Seedream 可灵  Vidu CosyVoice MiniMax 素材库   │
└─────────────────────────────────────────────────────────────┘
```

## 2. 架构决策记录 (ADR)

### ADR-1: Next.js 16 全栈
- **决策**: React 19 + App Router + Server Actions + TypeScript + Tailwind CSS v4
- **理由**: AI SDK 原生支持 DeepSeek/OpenAI 兼容端点（流式输出剧本）；Server Actions 简化表单驱动长任务；单进程部署简化运维；分镜墙受益于 React 并发渲染
- **备选**: Next.js + FastAPI 分离（否决：增加运维复杂度，AI 调用皆为 HTTP API 无需 Python 生态）

### ADR-2: 双 LLM 策略
| 任务 | 模型 | 端点 |
|---|---|---|
| 剧本创作（梗概/角色/剧本） | DeepSeek V3.2 | @ai-sdk/deepseek |
| 结构化任务（分镜/提示词/JSON） | 豆包 Doubao-Seed | @ai-sdk/openai + ark baseURL |
- 统一 `LLMProvider` 接口，可切换通义/Claude

### ADR-3: 角色一致性 = Seedream 5.0 多参考图生图
- **定妆**: 文生图 → 多参考图（2-10张）→ 组图模式（≤15张）生成多角度定妆照
- **分镜**: 每镜生成携带 [角色定妆照 + 场景空镜 + 风格参考图] 作为 `image` 参考
- **等效替代**: 本地 IP-Adapter 的云端实现（无需 GPU），实测一致性 80-90%
- **失败兜底**: 可灵 3.0 Omni 图生视频时再携带主体参考二次锁定

### ADR-4: 视频引擎 = 可灵 3.0 Omni 主 + Vidu 备
- 可灵 3.0 Omni: 主体参考/角色一致性最强、原生音画同步、异步 API + 回调、Node SDK
- Vidu: 0.04元/秒高速低成本备选
- **微动态策略**: 每镜独立生成 5-15s 短片段，规避长视频形变

### ADR-5: TTS = 阿里百炼 CosyVoice 主（可插拔）
- CosyVoice: 中文自然度第1、声音复刻、WebSocket 实时合成
- 适配器支持 MiniMax / 小米（API 待确认），一键切换

### ADR-6: 任务编排 = BullMQ (Redis)
- 5 队列: `script` / `image` / `video` / `audio` / `compose`
- 状态机: `QUEUED → PROCESSING → DONE | FAILED`（FAILED 可重试）
- 进度推送: BullMQ 事件 → Redis Pub/Sub → SSE (`/api/events`)

### ADR-7: 数据存储
- PostgreSQL (Prisma ORM): 全部业务元数据
- Redis: 队列 + 实时事件
- 本地文件系统 `storage/`: 图片/视频/音频/字幕（单用户无需 S3）

## 3. 数据模型

核心实体: `Project → (Script, Character[], Scene[], Episode[])`，`Episode → Shot[]`，全部 AI 任务统一 `GenTask` 追踪（含费用）。

详见 `prisma/schema.prisma`（15 个模型）。

## 4. 队列设计

| 队列 | 任务类型 | 并发 | 典型耗时 | 依赖 |
|---|---|---|---|---|
| script | LLM 生成（梗概/角色/剧本/分镜） | 3 | 10-60s | 无 |
| image | 定妆/场景/分镜图 | 3 | 30-90s | LLM 产出 |
| video | 可灵/Vidu 图生视频 | 2 | 30s-3min | 分镜图 |
| audio | TTS 配音/BGM/音效 | 3 | 10-60s | 剧本台词 |
| compose | FFmpeg 合成 | 1 | 1-5min | video+audio+subs |

## 5. 供应商适配器契约

统一接口 `ProviderConfig / TaskHandle / LLMProvider / ImageProvider / VideoProvider / TTSProvider / MusicProvider / SFXProvider`，定义于 `src/lib/providers/types.ts`。`registry.ts` 按配置路由，全部支持 mock 模式（无 Key 时用本地占位图/静音音频，保证全流程可跑通）。

## 6. 安全与合规

- API Key 仅存本地环境变量（`.env.local`），设置页可配置
- 商业版权: 各平台 API 输出版权按平台条款；Edge-TTS 仅作免费兜底标注风险
- 无用户数据上云（文件全本地）
