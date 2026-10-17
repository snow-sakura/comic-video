"""TTS 供应商实现：Edge-TTS(免费无Key,默认) / OpenAI 兼容(MiMo 等) / CosyVoice / Mock"""

from __future__ import annotations

import asyncio
import base64
import time
from dataclasses import dataclass
from typing import Any

import edge_tts
import httpx

from app.providers.base import TTSProvider, TTSVoice, TaskHandle
from app.providers.settings import get_setting_sync, get_tts_config
from app.storage import save_file, unique_name

# ========== Edge-TTS（微软免费，无需 Key） ==========

# 内置音色表（与 Node 端一致，供角色匹配）
EDGE_VOICES: list[dict] = [
    {"id": "zh-CN-YunxiNeural", "name": "云希（男·青年·活泼）", "gender": "male"},
    {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓（女·青年·温柔）", "gender": "female"},
    {"id": "zh-CN-YunyangNeural", "name": "云扬（男·成熟·沉稳）", "gender": "male"},
    {"id": "zh-CN-XiaoyiNeural", "name": "晓伊（女·成熟·知性）", "gender": "female"},
    {"id": "zh-CN-YunjianNeural", "name": "云健（男·青年·阳光）", "gender": "male"},
    {
        "id": "zh-CN-XiaoshuangNeural",
        "name": "晓双（女·少女·清脆）",
        "gender": "female",
    },
    {"id": "zh-CN-YunzeNeural", "name": "云泽（男·青年·磁性）", "gender": "male"},
    {"id": "zh-CN-XiaoniNeural", "name": "晓妮（女·青年·甜美）", "gender": "female"},
    {"id": "zh-CN-YunhaoNeural", "name": "云皓（男·少年·清亮）", "gender": "male"},
    {"id": "zh-CN-XiaomoNeural", "name": "晓墨（女·少女·软糯）", "gender": "female"},
]

_EMOTION_MAP = {
    "happy": "cheerful",
    "sad": "sad",
    "angry": "angry",
    "fearful": "fearful",
    "calm": "calm",
    "neutral": "neutral",
}


def match_voice_id(desc: str, gender: str | None = None) -> str:
    """按描述匹配音色（与 Node 端 matchVoiceId 对齐，简化版）"""
    if not desc:
        return "zh-CN-XiaoxiaoNeural" if gender == "female" else "zh-CN-YunxiNeural"
    for v in EDGE_VOICES:
        for kw in v["name"].split("（")[-1].replace("）", "").split("·"):
            if kw and kw in desc:
                return v["id"]
    # 性别兜底
    if gender == "female":
        return next(
            (v["id"] for v in EDGE_VOICES if v["gender"] == "female"),
            "zh-CN-XiaoxiaoNeural",
        )
    return next(
        (v["id"] for v in EDGE_VOICES if v["gender"] == "male"), "zh-CN-YunxiNeural"
    )


class EdgeTTSProvider(TTSProvider):
    id = "edge-tts"
    display_name = "Edge-TTS（微软免费）"

    async def synthesize(self, opts: dict) -> TaskHandle:
        text = opts.get("text", "")
        voice_id = (
            opts.get("voiceId") or get_setting_sync("tts.voice") or "zh-CN-YunxiNeural"
        )
        emotion = _EMOTION_MAP.get(opts.get("emotion", "neutral"), "neutral")
        rate = float(opts.get("rate", 1.0) or 1.0)

        communicate = edge_tts.Communicate(text, voice_id, rate=rate, style=emotion)
        audio_chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])
        audio = b"".join(audio_chunks)
        if len(audio) < 100:
            return TaskHandle(
                task_id=f"edge-{int(time.time() * 1000)}",
                status="failed",
                error="Edge-TTS 返回音频过短",
            )
        rel = save_file("audio", audio, ".mp3")
        return TaskHandle(
            task_id=f"edge-tts-{int(time.time() * 1000)}",
            status="done",
            result={"audioPath": rel},
        )

    async def list_voices(self) -> list[TTSVoice]:
        return [
            TTSVoice(id=v["id"], name=v["name"], gender=v.get("gender"))
            for v in EDGE_VOICES
        ]


def create_edge_tts() -> TTSProvider:
    return EdgeTTSProvider()


# ========== Mock ==========


class MockTTSProvider(TTSProvider):
    id = "mock-tts"
    display_name = "Mock TTS（无Key演示）"

    async def synthesize(self, opts: dict) -> TaskHandle:
        # 生成真实可被 ffprobe 解析的 MP3（正弦波 + 静音混合），
        # 之前写 1024 字节零填充导致 ffprobe 报 Invalid data，字幕估算/时长探测全部失败。
        import subprocess

        text = str(opts.get("text") or "")
        # 按中文字符数估算时长（约 4 字/秒），最少 2 秒
        est_sec = max(2.0, min(30.0, len(text) / 4.0))
        _, path, rel = unique_name("audio", ".mp3")
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    f"sine=frequency=440:duration={est_sec:.1f}",
                    "-af",
                    "volume=0.3",
                    "-codec:a",
                    "libmp3lame",
                    "-q:a",
                    "9",
                    str(path),
                ],
                capture_output=True,
                timeout=15,
            )
        except Exception:
            # ffmpeg 不可用时兜底写空文件（ffprobe 会失败，但至少不 crash handler）
            path.write_bytes(b"")
        return TaskHandle(
            task_id=f"mock-tts-{int(time.time() * 1000)}",
            status="done",
            result={"audioPath": rel},
        )

    async def list_voices(self) -> list[TTSVoice]:
        return [
            TTSVoice(id=v["id"], name=v["name"], gender=v.get("gender"))
            for v in EDGE_VOICES
        ]


def create_mock_tts() -> TTSProvider:
    return MockTTSProvider()


# ========== 小米 MiMo-TTS（OpenAI 兼容 chat/completions 协议，官方免费额度） ==========
# 小米 MiMo-TTS 不走标准 OpenAI /v1/audio/speech，而是通过 chat/completions 对话式调用：
#   POST {base}/chat/completions
#   body: {model: 'mimo-v2.5-tts', messages: [{assistant: 音色/风格指令}, {user: 待合成文本}]}
#   返回 choices[0].message.audio.data → base64 编码音频（WAV），解码保存即可。

# voiceId/音色关键词 → 中文音色指令（小米按自然语言指令控制音色/情绪）
_MIMO_VOICE_HINTS: dict[str, str] = {
    "zh-CN-XiaoxiaoNeural": "用少女音色，声音清脆甜美",
    "zh-CN-YunxiNeural": "用青年男声，声音清朗阳光",
    "zh-CN-XiaoyiNeural": "用成熟女声，声音知性温柔",
    "zh-CN-YunyangNeural": "用成熟男声，声音沉稳厚重",
    "zh-CN-YunhaoNeural": "用青年男声，声音磁性浑厚",
    "zh-CN-XiaoshuangNeural": "用少女音色，声音清脆活泼",
    "zh-CN-XiaoniNeural": "用少女音色，声音甜美细腻",
    "zh-CN-XiaomoNeural": "用少女音色，声音软糯温柔",
    "mimo-flash-zh": "用自然女声，语调柔和",
    "mimo-flash-zh-male": "用自然男声，语调平稳",
    "female-shaonv": "用少女音色，声音甜美清亮",
    "male-qn-qingse": "用青年男声，声音清亮",
    "male-chengshu": "用成熟男声，声音低沉磁性",
    "female-zhixi": "用知性女声，声音温婉知性",
}

_MIMO_EMOTION_CN: dict[str, str] = {
    "happy": "开心",
    "cheerful": "开心",
    "sad": "悲伤",
    "angry": "愤怒",
    "fearful": "恐惧",
    "calm": "平静",
    "neutral": "平静",
    "温柔": "温柔",
    "平静": "平静",
}


def _mimo_voice_instruction(
    voice_id: str | None, voice_name: str | None, emotion: str | None
) -> str:
    """根据 voiceId / voiceName / emotion 生成小米 TTS 的 assistant 音色指令"""
    hint = _MIMO_VOICE_HINTS.get(voice_id or "")
    if not hint and voice_name:
        hint = f"用{voice_name}的音色"
    if not hint:
        hint = "用自然流畅的声音"
    emo = _MIMO_EMOTION_CN.get(emotion or "", "平静")
    parts = [hint, f"情绪{emo}"]
    return "，".join(parts) + "朗读。"


class OpenAICompatTTSProvider(TTSProvider):
    """小米 MiMo-TTS（OpenAI 兼容 chat/completions 协议）

    默认对接小米官方免费额度（https://api.xiaomimimo.com/v1/chat/completions）；
    通过 tts.baseUrl 也可指向 TokenDance 等兼容网关（走 openai:chat-completions）。
    """

    id = "mimo-tts"
    display_name = "小米 MiMo-TTS（免费）"

    async def synthesize(self, opts: dict) -> TaskHandle:
        cfg = get_tts_config()
        api_key = cfg.get("apiKey") or ""
        if not api_key:
            return TaskHandle(
                task_id=f"mimo-{int(time.time() * 1000)}",
                status="failed",
                error="缺少 tts.apiKey（小米 MiMo TTS 需要）",
            )
        base = (cfg.get("baseUrl") or "https://api.xiaomimimo.com/v1").rstrip("/")
        model = cfg.get("model") or "mimo-v2.5-tts"
        voice_id = opts.get("voiceId") or cfg.get("voice") or ""
        text = str(opts.get("text") or "")
        if not text:
            return TaskHandle(
                task_id=f"mimo-{int(time.time() * 1000)}",
                status="failed",
                error="text 为空",
            )

        # 音色/情绪 → assistant 指令；文本 → user
        voice_instr = _mimo_voice_instruction(
            voice_id, opts.get("voiceName"), opts.get("emotion")
        )
        payload = {
            "model": model,
            "messages": [
                {"role": "assistant", "content": voice_instr},
                {"role": "user", "content": text},
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{base}/chat/completions",
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                )
        except Exception as e:
            return TaskHandle(
                task_id=f"mimo-{int(time.time() * 1000)}",
                status="failed",
                error=f"TTS 请求失败: {e}",
            )
        if resp.status_code != 200:
            return TaskHandle(
                task_id=f"mimo-{int(time.time() * 1000)}",
                status="failed",
                error=f"TTS HTTP {resp.status_code}: {resp.text[:200]}",
            )
        data = resp.json()
        try:
            msg = (data.get("choices") or [{}])[0].get("message", {})
            audio_data = (msg.get("audio") or {}).get("data", "")
            audio = base64.b64decode(audio_data)
        except Exception as e:
            return TaskHandle(
                task_id=f"mimo-{int(time.time() * 1000)}",
                status="failed",
                error=f"TTS 响应解析失败: {e}",
            )
        if len(audio) < 100:
            return TaskHandle(
                task_id=f"mimo-{int(time.time() * 1000)}",
                status="failed",
                error="TTS 返回音频过短",
            )
        # 小米返回 WAV（RIFF）；统一保存为 .wav，合成阶段可转码
        rel = save_file("audio", audio, ".wav")
        return TaskHandle(
            task_id=f"mimo-tts-{int(time.time() * 1000)}",
            status="done",
            result={"audioPath": rel},
        )

    async def list_voices(self) -> list[TTSVoice]:
        return [
            TTSVoice(id=v["id"], name=v["name"], gender=v.get("gender"))
            for v in EDGE_VOICES
        ]


def create_openai_compat_tts() -> TTSProvider:
    return OpenAICompatTTSProvider()


# ========== TokenDance 音频网关（小米 MiMo-TTS 经网关 / MiniMax Speech 2.8 / 豆包 Seed-TTS 2.0） ==========


class TokenDanceTTSProvider(TTSProvider):
    """TokenDance（词元跳动）音频网关适配器

    网关 baseUrl 固定为 https://tokendance.space/gateway/v1（TOKENDANCE_BASE_URL），
    需 TokenDance API Key（充值余额制，非免费）。按模型类型路由到对应原生协议：

    - 小米 MiMo-TTS（mimo-v2.5-tts*）→ openai:chat-completions（文本输入，响应携带音频内容）
    - MiniMax Speech 2.8（minimax-speech-*）→ minimax:t2a_v2（/gateway/minimax/v1/t2a_v2，hex 音频）
    - 豆包 Seed-TTS 2.0（seed-tts-2.0）→ ark:tts（/gateway/ark/v3/tts/unidirectional，SSE 音频帧）

    说明：TokenDance 网关本身按量计费；小米 TTS 真正免费方案请直连小米官方
    （engine=mimo，baseUrl=https://api.xiaomimimo.com/v1），本适配器为目录补充选项。
    """

    id = "tokendance-tts"
    display_name = "TokenDance 音频网关"

    _GATEWAY = "https://tokendance.space/gateway/v1"

    async def synthesize(self, opts: dict) -> TaskHandle:
        cfg = get_tts_config()
        api_key = cfg.get("apiKey") or ""
        if not api_key:
            return TaskHandle(
                task_id=f"td-{int(time.time() * 1000)}",
                status="failed",
                error="缺少 tts.apiKey（TokenDance 需要）",
            )
        model = cfg.get("model") or "mimo-v2.5-tts"
        text = str(opts.get("text") or "")
        if not text:
            return TaskHandle(
                task_id=f"td-{int(time.time() * 1000)}",
                status="failed",
                error="text 为空",
            )
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        base = self._GATEWAY
        mid = model.lower()

        try:
            # 小米 MiMo-TTS → openai:chat-completions
            if "mimo-v2.5-tts" in mid:
                payload = {
                    "model": model,
                    "messages": [
                        {
                            "role": "system",
                            "content": "你是 TTS 语音合成助手，输出中文语音",
                        },
                        {"role": "user", "content": text},
                    ],
                }
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.post(
                        f"{base}/chat/completions", json=payload, headers=headers
                    )
                if resp.status_code != 200:
                    return TaskHandle(
                        task_id=f"td-{int(time.time() * 1000)}",
                        status="failed",
                        error=f"TokenDance MiMo TTS HTTP {resp.status_code}: {resp.text[:200]}",
                    )
                data = resp.json()
                content = (data.get("choices") or [{}])[0].get("message", {}).get(
                    "content"
                ) or ""
                audio = _extract_audio_bytes(content)
                if not audio:
                    return TaskHandle(
                        task_id=f"td-{int(time.time() * 1000)}",
                        status="failed",
                        error="TokenDance MiMo TTS 未返回可解析音频",
                    )
            # MiniMax Speech 2.8 → minimax:t2a_v2
            elif "minimax-speech" in mid:
                voice = opts.get("voiceId") or cfg.get("voice") or "male-qn-qingse"
                payload = {
                    "model": model,
                    "text": text,
                    "voice_setting": {
                        "voice_id": voice,
                        "speed": 1,
                        "vol": 1,
                        "pitch": 0,
                    },
                    "audio_setting": {
                        "sample_rate": 32000,
                        "bitrate": 128000,
                        "format": "mp3",
                        "channel": 1,
                    },
                }
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.post(
                        f"{base}/minimax/v1/t2a_v2", json=payload, headers=headers
                    )
                if resp.status_code != 200:
                    return TaskHandle(
                        task_id=f"td-{int(time.time() * 1000)}",
                        status="failed",
                        error=f"TokenDance MiniMax TTS HTTP {resp.status_code}: {resp.text[:200]}",
                    )
                data = resp.json()
                audio_hex = (data.get("data") or {}).get("audio") or ""
                audio = bytes.fromhex(audio_hex) if audio_hex else b""
                if not audio:
                    return TaskHandle(
                        task_id=f"td-{int(time.time() * 1000)}",
                        status="failed",
                        error="TokenDance MiniMax TTS 返回音频为空",
                    )
            # 豆包 Seed-TTS 2.0 → ark:tts（SSE 音频帧）
            elif "seed-tts" in mid or "seed" in mid:
                speaker = (
                    opts.get("voiceId")
                    or cfg.get("voice")
                    or "zh_female_vv_uranus_bigtts"
                )
                payload = {
                    "req_params": {
                        "model": model,
                        "speaker": speaker,
                        "text": text,
                        "audio_params": {"format": "mp3", "sample_rate": 24000},
                    },
                    "mode": "single",
                }
                audio = b""
                async with httpx.AsyncClient(timeout=120.0) as client:
                    async with client.stream(
                        "POST",
                        f"{base}/ark/v3/tts/unidirectional",
                        json=payload,
                        headers=headers,
                    ) as resp:
                        if resp.status_code != 200:
                            return TaskHandle(
                                task_id=f"td-{int(time.time() * 1000)}",
                                status="failed",
                                error=f"TokenDance 豆包 TTS HTTP {resp.status_code}",
                            )
                        async for line in resp.aiter_lines():
                            if not line.strip():
                                continue
                            try:
                                import json as _json

                                frame = _json.loads(line)
                            except Exception:
                                continue
                            d = frame.get("data") if isinstance(frame, dict) else None
                            if d:
                                audio += base64.b64decode(d) if d else b""
                            if (
                                isinstance(frame, dict)
                                and frame.get("code") == 20000000
                            ):
                                break
                if not audio:
                    return TaskHandle(
                        task_id=f"td-{int(time.time() * 1000)}",
                        status="failed",
                        error="TokenDance 豆包 TTS 返回音频为空",
                    )
            else:
                return TaskHandle(
                    task_id=f"td-{int(time.time() * 1000)}",
                    status="failed",
                    error=f"TokenDance 未知音频模型: {model}",
                )
        except Exception as e:
            return TaskHandle(
                task_id=f"td-{int(time.time() * 1000)}",
                status="failed",
                error=f"TokenDance TTS 请求失败: {e}",
            )

        if len(audio) < 100:
            return TaskHandle(
                task_id=f"td-{int(time.time() * 1000)}",
                status="failed",
                error="TokenDance TTS 返回音频过短",
            )
        rel = save_file("audio", audio, ".mp3")
        return TaskHandle(
            task_id=f"td-tts-{int(time.time() * 1000)}",
            status="done",
            result={"audioPath": rel},
        )

    async def list_voices(self) -> list[TTSVoice]:
        return [
            TTSVoice(id=v["id"], name=v["name"], gender=v.get("gender"))
            for v in EDGE_VOICES
        ]


def _extract_audio_bytes(content: str) -> bytes:
    """从 TokenDance chat-completions 音频内容中提取音频字节。

    兼容三种返回形态：
    1. 纯 data URL：data:audio/mp3;base64,XXXX
    2. 含 base64 的 JSON 文本（{"audio":"..."} 或 {"data":"..."}）
    3. 标准 base64 字符串（自动去空白）
    """
    import base64
    import re

    if not content:
        return b""
    # data URL
    m = re.search(r"data:[a-zA-Z0-9+./-]+;base64,([A-Za-z0-9+/=\s]+)", content)
    if m:
        try:
            return base64.b64decode(re.sub(r"\s", "", m.group(1)))
        except Exception:
            pass
    # JSON 包裹
    try:
        import json as _json

        obj = _json.loads(content)
        for key in ("audio", "data", "audio_base64", "base64"):
            if isinstance(obj, dict) and obj.get(key):
                try:
                    return base64.b64decode(re.sub(r"\s", "", str(obj[key])))
                except Exception:
                    pass
    except Exception:
        pass
    # 纯 base64
    try:
        return base64.b64decode(re.sub(r"\s", "", content))
    except Exception:
        return b""


def create_tokendance_tts() -> TTSProvider:
    """TokenDance 音频网关（小米 MiMo-TTS / MiniMax Speech 2.8 / 豆包 Seed-TTS 2.0）"""
    return TokenDanceTTSProvider()


def create_tts_provider(engine: str | None = None) -> TTSProvider:
    engine = engine or get_setting_sync("tts.engine") or ""
    if engine == "edge-tts":
        return create_edge_tts()
    if engine == "mimo":
        return create_openai_compat_tts()
    if engine == "tokendance":
        return create_tokendance_tts()
    return create_mock_tts()


# ========== 音色匹配（供 agents 使用，与 Node 端 matchVoiceId 对齐） ==========

# 角色 voiceId 枚举（本地 confucius4 音色）
CONFUCIUS_VOICES = [
    {"id": "confucius-clear", "name": "清朗（男）", "gender": "male"},
    {"id": "confucius-deep", "name": "低沉（男）", "gender": "male"},
    {"id": "confucius-raspy", "name": "沙哑（男）", "gender": "male"},
    {"id": "confucius-mellow", "name": "温和（男）", "gender": "male"},
    {"id": "confucius-feminine", "name": "女性（女）", "gender": "female"},
    {"id": "confucius-mature-f", "name": "成熟女声（女）", "gender": "female"},
]
