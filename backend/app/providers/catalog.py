"""AI 模型目录（catalog）— 统一的预设模型清单，供设置页下拉选择

数据来源（2026-10 调研）：
- Agnes AI 官方文档 https://agnes-ai.com/zh-Hans/docs/overview + wiki.agnes-ai.com 定价页
- 小米 MiMo TTS（OpenAI 兼容）https://mimo.mi.com/docs 与 TokenDance 网关模型目录
- TokenDance（词元跳动）免费/商用音频模型 https://tokendance.space/gateway/v1/models
- VoxCPM 2（OpenBMB 本地开源 TTS）https://voxcpm.readthedocs.io

约定：
- 每个能力（text/image/video/tts）列出租户（provider/engine）及其 models
- status: "active"（已接通）| "planned"（规划中，未实现时 Mock 兜底）| "coming_soon"
- defaults 为出厂默认（与 core/config.py DEFAULTS 对齐）；实际生效值由 provider_settings 覆盖
"""

from __future__ import annotations

from typing import Any

AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1"
MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"
TOKENDANCE_BASE_URL = "https://tokendance.space/gateway/v1"

# ========== 文本 ==========

_agnes_text_models = [
    {
        "id": "agnes-3.0-flash",
        "name": "Agnes 3.0 Flash",
        "ctx": "512K",
        "tags": ["free", "default"],
        "note": "官方默认；Agent/工具调用/长上下文；当前促销免费",
    },
    {
        "id": "agnes-2.5-flash",
        "name": "Agnes 2.5 Flash",
        "ctx": "512K",
        "tags": ["free"],
        "note": "升级版 2.0，编码/Agent 增强；当前促销免费",
    },
    {
        "id": "agnes-3.0-flash-max",
        "name": "Agnes 3.0 Flash Max",
        "ctx": "512K",
        "tags": [],
        "note": "推理型，128K 输出预算",
    },
    {
        "id": "agnes-2.5-pro",
        "name": "Agnes 2.5 Pro",
        "ctx": "长上下文",
        "tags": ["paid"],
        "note": "商业稳定版：高级编码/科学推理/长文分析",
    },
    {
        "id": "agnes-2.5-pro-beta",
        "name": "Agnes 2.5 Pro Beta",
        "ctx": "长上下文",
        "tags": ["paid"],
        "note": "Beta 推理/编码，价格约为 Pro 的 1/3",
    },
    {
        "id": "agnes-1.5-flash",
        "name": "Agnes 1.5 Flash",
        "ctx": "256K",
        "tags": [],
        "note": "低延迟轻量档",
    },
    {
        "id": "agnes-3.0-pro",
        "name": "Agnes 3.0 Pro",
        "ctx": "长上下文",
        "tags": [],
        "status": "coming_soon",
        "note": "专业文档分析/科学编码（官方即将上线）",
    },
]

_openai_compat_text_models = [
    {
        "id": "deepseek-v4-flash-free",
        "name": "DeepSeek v4 Flash（OpenCode Zen）",
        "ctx": "长上下文",
        "tags": ["free"],
        "note": "通用 OpenAI 兼容网关免费档",
    },
    {
        "id": "mimo-v2.6-flash",
        "name": "小米 MiMo v2.6 Flash",
        "ctx": "长上下文",
        "tags": ["free"],
        "note": "全模态高智能低耗；兼容 OpenAI 协议（api.xiaomimimo.com 或 TokenDance）",
    },
    {
        "id": "mimo-v2.6-pro",
        "name": "小米 MiMo v2.6 Pro",
        "ctx": "1M",
        "tags": [],
        "note": "旗舰推理（MoE 309B）；按量计费",
    },
]

# ========== 图像 ==========

_agnes_image_models = [
    {
        "id": "agnes-image-2.5-flash",
        "name": "Agnes Image 2.5 Flash",
        "tags": ["free", "default"],
        "note": "最新一代；文生图/图生图/多图参考；当前全分辨率免费",
    },
    {
        "id": "agnes-image-2.1-flash",
        "name": "Agnes Image 2.1 Flash",
        "tags": ["free"],
        "note": "高信息密度视觉优化",
    },
    {
        "id": "agnes-image-2.0-flash",
        "name": "Agnes Image 2.0 Flash",
        "tags": ["free"],
        "note": "上一代，仍免费可用",
    },
]

# ========== 视频 ==========

_agnes_video_models = [
    {
        "id": "agnes-video-2.5-flash",
        "name": "Agnes Video 2.5 Flash",
        "tags": ["free", "default"],
        "note": "文生视频/关键帧控制/图生视频；限时免费（限流 1 次/分）",
    },
    {
        "id": "agnes-video-2.5",
        "name": "Agnes Video 2.5",
        "tags": ["paid"],
        "note": "正价档：720P $0.025/s 起，多模态参考生成",
    },
]

# ========== 音频（TTS） ==========

_mimo_tts_models = [
    {
        "id": "mimo-v2.5-tts",
        "name": "MiMo-V2.5-TTS（免费·默认）",
        "tags": ["free", "default"],
        "note": "多场景高品质 TTS：内置精品音色 + 语速/情绪/语气控制；OpenAI 兼容 /v1/audio/speech；小米官方免费额度基础版 704K tokens",
    },
    {
        "id": "mimo-v2.5-tts-voiceclone",
        "name": "MiMo-V2.5-TTS-VoiceClone",
        "tags": ["free"],
        "note": "少量样本高保真复刻目标音色，保持风格指令与音频标签控制",
    },
    {
        "id": "mimo-v2.5-tts-voicedesign",
        "name": "MiMo-V2.5-TTS-VoiceDesign",
        "tags": ["free"],
        "note": "一句话快速定义并生成全新音色，个性化声音设计",
    },
]

# TokenDance（词元跳动）网关音频模型（按量计费；baseUrl=https://tokendance.space/gateway/v1）
_tokendance_audio_models = [
    {
        "id": "mimo-v2.5-tts",
        "name": "小米 MiMo-V2.5-TTS（经 TokenDance）",
        "tags": [],
        "note": "经 TokenDance 网关调用小米 TTS（openai:chat-completions）；需 TokenDance 额度",
    },
    {
        "id": "minimax-speech-2.8-hd",
        "name": "MiniMax Speech-2.8-HD",
        "tags": [],
        "note": "新一代语音 HD，情绪渲染融合语气词（minimax:t2a_v2 协议）",
    },
    {
        "id": "minimax-speech-2.8-turbo",
        "name": "MiniMax Speech-2.8-Turbo",
        "tags": [],
        "note": "新一代语音 Turbo，极致生成速度（minimax:t2a_v2 协议）",
    },
    {
        "id": "seed-tts-2.0",
        "name": "豆包 Seed-TTS 2.0",
        "tags": [],
        "note": "字节新一代 TTS，情绪/语速/语调控制（ark:tts 协议）",
    },
]

# 小米 MiMo-TTS 官方免费直连内置精品音色
_mimo_tts_voices = [
    {"id": "mimo-flash-zh", "name": "小米默认女声"},
    {"id": "mimo-flash-zh-male", "name": "小米默认男声"},
    {"id": "male-qn-qingse", "name": "青年男声"},
    {"id": "female-shaonv", "name": "少女音"},
    {"id": "male-chengshu", "name": "成熟男声"},
    {"id": "female-zhixi", "name": "知性女声"},
]

_catalog: dict[str, Any] = {
    "text": {
        "label": "文本（LLM）",
        "defaults": {
            "provider": "agnes",
            "model": "agnes-3.0-flash",
            "baseUrl": AGNES_BASE_URL,
        },
        "providers": [
            {
                "id": "agnes",
                "name": "Agnes AI（官方默认）",
                "baseUrl": AGNES_BASE_URL,
                "requiresKey": True,
                "apiKeyHint": "在 Agnes 控制台创建 API Key",
                "models": _agnes_text_models,
            },
            {
                "id": "openai",
                "name": "通用 OpenAI 兼容",
                "baseUrl": "",
                "requiresKey": True,
                "apiKeyHint": "自定义 BASE_URL + Key（OpenCode Zen / 小米 MiMo / TokenDance 等）",
                "models": _openai_compat_text_models,
            },
            {
                "id": "mock",
                "name": "Mock（演示）",
                "requiresKey": False,
                "models": [],
            },
        ],
    },
    "image": {
        "label": "图像",
        "defaults": {
            "provider": "agnes",
            "model": "agnes-image-2.5-flash",
            "baseUrl": AGNES_BASE_URL,
        },
        "providers": [
            {
                "id": "agnes",
                "name": "Agnes AI（官方默认）",
                "baseUrl": AGNES_BASE_URL,
                "requiresKey": True,
                "apiKeyHint": "Agnes API Key（图像与文本共用）",
                "models": _agnes_image_models,
            },
            {
                "id": "mock",
                "name": "Mock（演示）",
                "requiresKey": False,
                "models": [],
            },
        ],
    },
    "video": {
        "label": "视频",
        "defaults": {
            "provider": "agnes",
            "model": "agnes-video-2.5-flash",
            "baseUrl": AGNES_BASE_URL,
        },
        "providers": [
            {
                "id": "agnes",
                "name": "Agnes AI（官方默认）",
                "baseUrl": AGNES_BASE_URL,
                "requiresKey": True,
                "apiKeyHint": "Agnes API Key；注意限流 1 次/分钟",
                "models": _agnes_video_models,
            },
            {
                "id": "mock",
                "name": "Mock（演示）",
                "requiresKey": False,
                "models": [],
            },
        ],
    },
    "tts": {
        "label": "音频（TTS 配音）",
        "defaults": {
            "engine": "",
            "model": "",
            "voice": "",
            "baseUrl": "",
        },
        "engines": [
            {
                "id": "",
                "name": "Mock（本地占位·默认）",
                "requiresKey": False,
                "status": "active",
                "note": "ffmpeg 生成可解析占位 MP3，零依赖跑通全流程",
                "models": [],
                "voices": [],
            },
            {
                "id": "edge-tts",
                "name": "Edge-TTS（微软免费）",
                "requiresKey": False,
                "status": "active",
                "note": "神经中文音色 10 款，无需 Key",
                "models": [],
                "voices": [
                    {"id": "zh-CN-YunxiNeural", "name": "云希（男·青年·活泼）"},
                    {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓（女·青年·温柔）"},
                    {"id": "zh-CN-YunyangNeural", "name": "云扬（男·成熟·沉稳）"},
                    {"id": "zh-CN-XiaoyiNeural", "name": "晓伊（女·成熟·知性）"},
                    {"id": "zh-CN-YunjianNeural", "name": "云健（男·青年·阳光）"},
                    {"id": "zh-CN-XiaoshuangNeural", "name": "晓双（女·少女·清脆）"},
                    {"id": "zh-CN-YunzeNeural", "name": "云泽（男·青年·磁性）"},
                    {"id": "zh-CN-XiaoniNeural", "name": "晓妮（女·青年·甜美）"},
                    {"id": "zh-CN-YunhaoNeural", "name": "云皓（男·少年·清亮）"},
                    {"id": "zh-CN-XiaomoNeural", "name": "晓墨（女·少女·软糯）"},
                ],
            },
            {
                "id": "mimo",
                "name": "小米 MiMo-TTS（免费）",
                "requiresKey": True,
                "status": "active",
                "baseUrl": MIMO_BASE_URL,
                "apiKeyHint": "小米 MiMo API Key；OpenAI 兼容 /v1/audio/speech；官方免费额度：基础版 704K tokens；也可经 TokenDance 网关 https://tokendance.space/gateway/v1 调用（按量计费）",
                "note": "小米官方直连免费额度优先；内置精品音色 + 语速/情绪/语气控制 + 音色克隆/设计；tts.baseUrl 改指向 TokenDance 即可经网关调用",
                "models": _mimo_tts_models,
                "voices": _mimo_tts_voices,
            },
            {
                "id": "tokendance",
                "name": "TokenDance 音频网关（按量计费）",
                "requiresKey": True,
                "status": "active",
                "baseUrl": TOKENDANCE_BASE_URL,
                "apiKeyHint": "TokenDance API Key；https://tokendance.space/keys 创建；充值余额制（非免费）",
                "note": "统一网关聚合小米 MiMo-TTS / MiniMax Speech 2.8 / 豆包 Seed-TTS 2.0；不同模型走各自原生协议；已预留适配器",
                "models": _tokendance_audio_models,
                "voices": _mimo_tts_voices,
            },
            {
                "id": "confucius4",
                "name": "Confucius 4（本地）",
                "requiresKey": False,
                "status": "active",
                "note": "本地合成引擎，6 款内置音色",
                "models": [],
                "voices": [
                    {"id": "confucius-clear", "name": "清晰"},
                    {"id": "confucius-deep", "name": "低沉"},
                    {"id": "confucius-raspy", "name": "沙哑"},
                    {"id": "confucius-mellow", "name": "圆润"},
                    {"id": "confucius-feminine", "name": "女声"},
                    {"id": "confucius-mature-f", "name": "成熟女声"},
                ],
            },
            {
                "id": "voxcpm",
                "name": "VoxCPM 2（本地开源·OpenBMB）",
                "requiresKey": False,
                "status": "planned",
                "note": "pip install voxcpm；HuggingFace 权重 openbmb/VoxCPM2；支持 CUDA/MPS/CPU；零费用本地推理",
                "models": [
                    {
                        "id": "openbmb/VoxCPM2",
                        "name": "VoxCPM 2",
                        "tags": ["free", "local"],
                        "note": "零 Key 本地推理；需单独部署推理服务",
                    },
                ],
                "voices": [],
            },
        ],
    },
}


def get_catalog() -> dict[str, Any]:
    """返回模型目录（深拷贝保护内部结构）"""
    import copy

    return copy.deepcopy(_catalog)


def catalog_provider_ids(category: str) -> list[str]:
    """某能力下的全部 provider/engine id（含 mock / 空串）"""
    cat = _catalog.get(category) or {}
    if category == "tts":
        return [e["id"] for e in cat.get("engines", [])]
    return [p["id"] for p in cat.get("providers", [])]


def catalog_model_ids(category: str, provider: str) -> list[str]:
    """某能力某供应商下的全部 model id"""
    cat = _catalog.get(category) or {}
    entries = cat.get("engines", []) if category == "tts" else cat.get("providers", [])
    for e in entries:
        if e["id"] == provider:
            return [m["id"] for m in e.get("models", [])]
    return []


def catalog_defaults(category: str) -> dict[str, str]:
    """出厂默认配置（文本/图像/视频为 provider+model；tts 为 engine+model+voice）"""
    return dict((_catalog.get(category) or {}).get("defaults", {}))


def get_model_tier(category: str, model_id: str | None) -> str:
    """查询模型计费档位：free（单任务串行）| paid（多并行进程）。

    按目录模型 tags 判定；未知模型按免费档处理（保守限流）。
    """
    cat = _catalog.get(category) or {}
    entries = cat.get("engines", []) if category == "tts" else cat.get("providers", [])
    for e in entries:
        for m in e.get("models", []):
            if m.get("id") == model_id:
                tags = m.get("tags") or []
                if "paid" in tags:
                    return "paid"
                return "free"
    return "free"
