"""剧本工坊 三 Agent 流水线

每个 Agent = LLM 结构化输出（优先） + 启发式回退（Mock/失败时保证有产出）。
由 script 队列的 Celery worker 调用，输入/输出均落库：
  Agent1 extractCharacters → Character 表
  Agent2 generateOutline   → Script 行（logline + 大纲骨架）
  Agent3 generateEpisode   → Script.content.episodes[i] + Episode 行
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Project,
    Script,
    Character,
    Episode,
)
from app.providers.registry import get_text_llm
from app.providers.base import LLMOptions
from app.novel import (
    parse_novel,
    chapter_text,
    chapters_digest,
    heuristic_characters,
    NovelMeta,
)


def _meta_chapters(meta) -> list[dict]:
    """meta 可能是 NovelMeta 或 dict，统一取 chapters 列表"""
    if isinstance(meta, dict):
        return meta.get("chapters") or []
    return getattr(meta, "chapters", None) or []


from app.json_utils import safe_parse_json, as_record, as_string, as_string_array
from app.prompts.registry import render_prompt

logger = logging.getLogger(__name__)

EPISODE_COUNT = 6  # 默认集数

ROLE_SET = ("protagonist", "supporting", "antagonist", "utility")
GENDER_MAP = {
    "male": "male",
    "男": "male",
    "男性": "male",
    "男声": "male",
    "female": "female",
    "女": "female",
    "女性": "female",
    "女声": "female",
}

# 音色关键词 → 标准 voiceId（与 Node 端 VOICE_MATCH_RULES 对齐，适配 Agnes edge-tts）
VOICE_MATCH_RULES: list[tuple[list[str], str]] = [
    (["少女", "清脆", "俏皮", "甜", "清亮女"], "zh-CN-XiaoxiaoNeural"),
    (["少年", "青年男", "清朗", "阳光"], "zh-CN-YunxiNeural"),
    (["慈祥", "年长女", "老妇", "奶奶"], "zh-CN-XiaohanNeural"),
    (["低沉", "苍老", "老者", "沧桑", "威严", "压迫"], "zh-CN-YunfengNeural"),
    (["沙哑", "浑厚", "磁性", "豪爽", "厚重", "粗犷"], "zh-CN-YunhaoNeural"),
    (["温和", "沉稳", "知性", "温柔", "成熟"], "zh-CN-YunxiNeural"),
]
FEMALE_VOICE_IDS = {
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-XiaohanNeural",
    "zh-CN-XiaomengNeural",
    "zh-CN-XiaomoNeural",
    "zh-CN-XiaoruiNeural",
    "zh-CN-XiaoshuangNeural",
}
MALE_VOICE_IDS = {
    "zh-CN-YunxiNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunfengNeural",
    "zh-CN-YunhaoNeural",
    "zh-CN-YunzeNeural",
    "zh-CN-YunxiaNeural",
}


def _valid_role(role: str) -> str:
    return role if role in ROLE_SET else "supporting"


def _normalize_gender(g: str | None) -> str:
    v = (g or "").strip().lower()
    return GENDER_MAP.get(v, "unknown")


def match_voice_id(desc: str | None, gender: str | None = None) -> str:
    """音色描述 → 标准 voiceId（关键词匹配，性别兜底）"""
    text = desc or ""
    for keywords, vid in VOICE_MATCH_RULES:
        if text and any(k in text for k in keywords):
            return vid
    # 性别兜底
    if gender == "female":
        return "zh-CN-XiaoxiaoNeural"
    if gender == "male":
        return "zh-CN-YunxiNeural"
    return "zh-CN-YunxiNeural"


def _infer_voice_id(c: dict) -> str | None:
    """角色 → 标准 voiceId：合法枚举直接用；否则按 voiceName 描述匹配"""
    raw = (c.get("voiceId") or "").strip()
    if raw in FEMALE_VOICE_IDS or raw in MALE_VOICE_IDS:
        # 性别冲突纠正
        if c.get("gender") == "female" and raw in MALE_VOICE_IDS:
            return "zh-CN-XiaoxiaoNeural"
        if c.get("gender") == "male" and raw in FEMALE_VOICE_IDS:
            return "zh-CN-YunxiNeural"
        return raw
    matched = match_voice_id(c.get("voiceName"), c.get("gender"))
    return matched if matched in FEMALE_VOICE_IDS or matched in MALE_VOICE_IDS else None


# ========== 工具 ==========


async def _llm_json(db: AsyncSession, messages: list[dict]) -> Any:
    """调用 LLM 取 JSON，失败返回 None（触发启发式回退）"""
    try:
        llm = get_text_llm()
        raw = await llm.chat(
            messages, LLMOptions(json=True, temperature=0.6, max_tokens=16384)
        )
        return safe_parse_json(raw)
    except Exception as e:
        logger.warning("[agents] LLM JSON 调用失败: %s", e)
        return None


async def _get_novel(db: AsyncSession, project_id: str) -> tuple[str, Any]:
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not project:
        raise ValueError("项目不存在")
    if not project.novel_text:
        raise ValueError("尚未上传小说，请先在剧本工坊上传小说文本")
    # 统一返回 (text, NovelMeta)：DB 的 novel_meta 可能是 dict，还原为 NovelMeta
    meta = as_record(project.novel_meta)
    if meta.get("chapters"):
        novel_meta = parse_novel(project.novel_text)  # 重新解析拿到 char/word 数
        novel_meta.chapters = meta["chapters"]
        if meta.get("title"):
            novel_meta.title = meta["title"]
    else:
        novel_meta = parse_novel(project.novel_text)
    return project.novel_text, novel_meta


async def _set_stage(db: AsyncSession, project_id: str, stage: str) -> None:
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not project:
        return
    project.script_stage = stage
    # 同步保留到 novel_meta（兼容旧读取方）
    meta = as_record(project.novel_meta)
    meta["stage"] = stage
    project.novel_meta = meta
    await db.flush()


async def _script_id(db: AsyncSession, project_id: str) -> str:
    """项目当前 Script 行 id（没有则创建空行）"""
    existing = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == project_id)
                .order_by(Script.version.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if existing:
        return existing.id
    script = Script(project_id=project_id)
    db.add(script)
    await db.flush()
    return script.id


# ========== Agent 1：角色提炼 ==========


async def run_extract_characters(db: AsyncSession, project_id: str) -> dict[str, Any]:
    text, meta = await _get_novel(db, project_id)
    digest = chapters_digest(meta, text)

    full_text = text[:12000]
    schema = {
        "logline": "一句话核心梗概（30字内，含核心冲突）",
        "worldView": "世界观简述（时代/地点/超自然设定，80字内）",
        "genre": '题材标签数组，如 ["都市","奇幻"]',
        "characters": [
            {
                "name": "角色名（最常用称呼，同一人物多种叫法须合并）",
                "gender": "male | female | unknown（必须给，按剧情证据推断）",
                "role": "protagonist | supporting | antagonist | utility",
                "appearance": {
                    "hair": "发型发色（与其他角色区分）",
                    "costume": "日常服饰（含主色调）",
                    "facialMarkers": "面部特征",
                    "body": "体型",
                    "style": "整体风格",
                },
                "personality": {
                    "habits": "习惯动作",
                    "emotionalReactions": "情绪反应模式",
                    "speechStyle": "说话风格",
                    "psychology": "心理动机",
                },
                "voiceName": "配音音色描述（3-10字，含明确性别词与气质词）",
            },
        ],
    }
    user_prompt = await render_prompt(
        "extract",
        {
            "jsonSchema": json.dumps(schema, ensure_ascii=False, indent=2),
            "novelDigest": digest,
            "fullText": full_text,
        },
        project_id,
    )

    parsed = await _llm_json(
        db,
        [
            {"role": "system", "content": "你是漫剧编剧统筹，只输出 JSON。"},
            {"role": "user", "content": user_prompt},
        ],
    )

    logline: str | None = None
    world_view: str | None = None
    chars: list[dict] = []

    if parsed and isinstance(as_record(parsed).get("characters"), list):
        rec = as_record(parsed)
        logline = as_string(rec.get("logline")) or None
        world_view = as_string(rec.get("worldView")) or None
        for raw_c in rec["characters"]:
            r = as_record(raw_c)
            appearance = as_record(r.get("appearance"))
            personality = as_record(r.get("personality"))
            chars.append(
                {
                    "name": as_string(r.get("name")),
                    "role": _valid_role(as_string(r.get("role"))),
                    "gender": _normalize_gender(as_string(r.get("gender"))),
                    "appearance": {
                        "hair": as_string(appearance.get("hair"), "待定"),
                        "costume": as_string(appearance.get("costume"), "待定"),
                        "facialMarkers": as_string(
                            appearance.get("facialMarkers"), "待定"
                        ),
                        "body": as_string(appearance.get("body"), "待定"),
                        "style": as_string(appearance.get("style"), "待定"),
                    },
                    "personality": {
                        "habits": as_string(personality.get("habits"), "待定"),
                        "emotionalReactions": as_string(
                            personality.get("emotionalReactions"), "待定"
                        ),
                        "speechStyle": as_string(
                            personality.get("speechStyle"), "待定"
                        ),
                        "psychology": as_string(personality.get("psychology"), "待定"),
                    },
                    "voiceName": as_string(r.get("voiceName")) or None,
                    "voiceId": as_string(r.get("voiceId")) or None,
                }
            )
        chars = [c for c in chars if c["name"]]
    else:
        # 启发式回退
        logger.warning(
            "[agents] 角色提炼 LLM 输出无效，回退启发式提取 projectId=%s", project_id
        )
        chars = []
        for c in heuristic_characters(text):
            chars.append(
                {
                    "name": c["name"],
                    "role": c["role"],
                    "gender": c.get("gender", "unknown"),
                    "appearance": c["appearance"],
                    "personality": c["personality"],
                    "voiceName": None,
                }
            )
        logline = None
        world_view = None

    # 落库：清空旧角色后写入
    await db.execute(delete(Character).where(Character.project_id == project_id))
    if chars:
        for c in chars:
            voice_id = _infer_voice_id(c)
            db.add(
                Character(
                    project_id=project_id,
                    name=c["name"],
                    role=c["role"],
                    gender=c.get("gender"),
                    appearance=c["appearance"],
                    personality=c["personality"],
                    voice_name=c.get("voiceName"),
                    voice_id=voice_id,
                    status="DRAFTING",
                )
            )
        await db.flush()

    # 角色卡写进 Script
    sid = await _script_id(db, project_id)
    script = (
        await db.execute(select(Script).where(Script.id == sid))
    ).scalar_one_or_none()
    content = (
        dict(as_record(script.content)) if script else {}
    )  # 拷贝，避免原地改+同引用赋值导致 SQLAlchemy 检测不到变更
    content["worldView"] = world_view
    content["characters"] = chars
    if script:
        script.logline = logline
        script.content = content
    else:
        db.add(
            Script(
                project_id=project_id,
                logline=logline,
                content=content,
                status="draft",
            )
        )
    await db.flush()
    await _set_stage(db, project_id, "characters")
    return {"count": len(chars), "logline": logline}


# ========== Agent 2：分集大纲 ==========


async def run_generate_outline(
    db: AsyncSession, project_id: str, override_count: int | None = None
) -> dict[str, Any]:
    text, meta = await _get_novel(db, project_id)
    digest = chapters_digest(meta, text)

    script = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == project_id)
                .order_by(Script.version.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    characters = (
        (await db.execute(select(Character).where(Character.project_id == project_id)))
        .scalars()
        .all()
    )
    if not characters:
        raise ValueError("请先提炼角色")

    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one()
    count_raw = (
        override_count
        if override_count is not None
        else (project.episode_count or EPISODE_COUNT)
    )
    episode_count = max(1, min(int(round(count_raw)) or 1, 60))
    if override_count and project.episode_count != episode_count:
        project.episode_count = episode_count

    prev_content = as_record(script.content) if script else {}
    logline_prev = as_string(prev_content.get("logline"))
    world_view = as_string(prev_content.get("worldView"))
    char_list = [
        {"name": c.name, "role": c.role, "gender": c.gender} for c in characters
    ]

    schema = {
        "logline": "一句话核心梗概（与输入保持一致）",
        "episodes": [
            {
                "number": 1,
                "title": "集标题（8字内，吸睛）",
                "hookEnd": "集尾悬念/钩子（30字内，必须制造追剧动机）",
                "summary": "本集剧情概述（100字内）",
                "scenes": [
                    {
                        "location": "场景地点",
                        "time": "时间/氛围",
                        "summary": "本场景发生的事（40字内）",
                    }
                ],
            },
        ],
    }
    user_prompt = await render_prompt(
        "outline",
        {
            "jsonSchema": json.dumps(schema, ensure_ascii=False, indent=2),
            "logline": logline_prev,
            "worldView": world_view,
            "characters": "、".join(
                f"{c['name']}({c['role']}"
                + (f"·{_gender_cn(c['gender'])}" if c.get("gender") else "")
                + ")"
                for c in char_list
            ),
            "episodeCount": str(episode_count),
            "novelDigest": digest,
        },
        project_id,
    )

    parsed = await _llm_json(
        db,
        [
            {"role": "system", "content": "你是漫剧总编剧，只输出 JSON。"},
            {"role": "user", "content": user_prompt},
        ],
    )

    logline = logline_prev or as_string(as_record(parsed).get("logline")) or None
    episodes: list[dict] = []
    if parsed and isinstance(as_record(parsed).get("episodes"), list):
        for i, raw_e in enumerate(as_record(parsed)["episodes"]):
            r = as_record(raw_e)
            scenes_raw = r.get("scenes")
            scenes = []
            if isinstance(scenes_raw, list):
                for s in scenes_raw:
                    sr = as_record(s)
                    scenes.append(
                        {
                            "location": as_string(sr.get("location"), "未知场景"),
                            "time": as_string(sr.get("time"), "日"),
                            "summary": as_string(sr.get("summary"), ""),
                        }
                    )
            else:
                scenes = [{"location": "主线场景", "time": "日", "summary": ""}]
            episodes.append(
                {
                    "number": int(as_string(r.get("number"), str(i + 1)) or i + 1),
                    "title": as_string(r.get("title"), f"第{i + 1}集"),
                    "hookEnd": as_string(r.get("hookEnd"), "悬念待定"),
                    "summary": as_string(r.get("summary"), ""),
                    "scenes": scenes,
                }
            )
        # 集数校验：LLM 返回的集数可能少于/多于目标，按 episode_count 归一，
        # 不足则用章节内容补齐，超出则截断，确保"目标几集就产出几集"。
        if len(episodes) > episode_count:
            episodes = episodes[:episode_count]
        elif len(episodes) < episode_count:
            chs_pad = _meta_chapters(meta)
            for j in range(len(episodes), episode_count):
                ch = chs_pad[j % len(chs_pad)] if chs_pad else None
                ch_body = (
                    "".join(chapter_text(meta, text, ch["index"]).split())[:120]
                    if ch
                    else ""
                )
                episodes.append(
                    {
                        "number": j + 1,
                        "title": ch["title"] if ch else f"第{j + 1}集",
                        "hookEnd": f"第{j + 1}集结尾埋下反转钩子",
                        "summary": f"围绕「{ch['title'] if ch else f'第{j + 1}集'}」展开：{ch_body}…"
                        if ch_body
                        else f"第{j + 1}集剧情推进",
                        "scenes": [
                            {
                                "location": "主线场景",
                                "time": "日",
                                "summary": ch_body or "剧情推进",
                            }
                        ],
                    }
                )
        # 重新编号，保证 number 连续从 1 开始
        for idx, ep in enumerate(episodes):
            ep["number"] = idx + 1
    else:
        # 回退：按章节生成基础大纲
        # 注意：章节数可能少于目标集数（如单章小说拆多集），
        # 因此以 episode_count 为准，章节内容循环复用，不要 min(章节) 截断。
        chs = _meta_chapters(meta)
        count = episode_count
        for i in range(count):
            ch = chs[i % len(chs)] if chs else None
            ch_body = (
                "".join(chapter_text(meta, text, ch["index"]).split())[:120]
                if ch
                else ""
            )
            base_title = ch["title"] if ch else f"第{i + 1}集"
            title = base_title if i < len(chs) or not chs else f"{base_title}·{i + 1}"
            episodes.append(
                {
                    "number": i + 1,
                    "title": title,
                    "hookEnd": f"第{i + 1}集结尾埋下反转钩子",
                    "summary": f"围绕「{title}」展开：{ch_body}…"
                    if ch_body
                    else f"第{i + 1}集剧情推进",
                    "scenes": [
                        {
                            "location": "主线场景",
                            "time": "日",
                            "summary": ch_body or "剧情推进",
                        }
                    ],
                }
            )
        logline = logline or f"《{project.title}》的漫剧改编"

    # 落库：更新 Script（保留角色卡与已有剧本）
    sid = await _script_id(db, project_id)
    script = (await db.execute(select(Script).where(Script.id == sid))).scalar_one()
    prev_content = as_record(script.content)
    content = dict(prev_content)
    content["worldView"] = content.get("worldView")
    content["episodes"] = content.get("episodes", [])  # 绝不覆盖已有剧本
    content["episodeOutlines"] = episodes
    script.logline = logline
    script.content = content
    await db.flush()

    # Episode 骨架行
    # 裁剪超出新集数的行
    await db.execute(
        delete(Episode).where(
            Episode.project_id == project_id,
            Episode.number > episode_count,
        )
    )
    for ep in episodes:
        existing = (
            (
                await db.execute(
                    select(Episode).where(
                        Episode.project_id == project_id,
                        Episode.number == ep["number"],
                    )
                )
            )
            .scalars()
            .first()
        )
        if existing:
            existing.title = ep["title"]
            existing.hook_end = ep["hookEnd"]
        else:
            db.add(
                Episode(
                    project_id=project_id,
                    number=ep["number"],
                    title=ep["title"],
                    hook_end=ep["hookEnd"],
                    status="draft",
                )
            )
    await db.flush()
    await _set_stage(db, project_id, "outline")
    return {"episodes": len(episodes), "logline": logline}


def _gender_cn(g: str | None) -> str:
    return {"male": "男", "female": "女"}.get(g or "", "未知")


# ========== Agent 3：单集分镜剧本 ==========


async def run_generate_episode(
    db: AsyncSession, project_id: str, episode_number: int
) -> dict[str, Any]:
    text, meta = await _get_novel(db, project_id)

    script = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == project_id)
                .order_by(Script.version.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if not script:
        raise ValueError("请先生成大纲")

    content = as_record(script.content)
    outlines = content.get("episodeOutlines") or []
    outline = next(
        (
            o
            for o in outlines
            if isinstance(o, dict) and o.get("number") == episode_number
        ),
        None,
    )
    if not outline:
        raise ValueError(f"第{episode_number}集大纲不存在，请先生成大纲")

    characters = (
        (await db.execute(select(Character).where(Character.project_id == project_id)))
        .scalars()
        .all()
    )

    chapters = _meta_chapters(meta)
    per_chapter = (
        chapter_text(meta, text, episode_number)
        if len(chapters) >= episode_number
        else text
    )

    char_desc = "\n".join(
        f"{c.name}（{c.role}"
        + (f"·{_gender_cn(c.gender)}" if c.gender else "")
        + f"）："
        f"外貌 {json.dumps(as_record(c.appearance), ensure_ascii=False)}；"
        f"性格 {json.dumps(as_record(c.personality), ensure_ascii=False)}"
        for c in characters
    )

    schema = {
        "number": outline["number"],
        "title": "集标题",
        "hookEnd": "集尾悬念",
        "scenes": [
            {
                "location": "场景地点（如：雨夜小巷）",
                "time": "时间/氛围（如：夜·雨）",
                "characters": ["在场角色名"],
                "action": "画面动作描述（80-150字，含环境细节、角色动作、景别建议）",
                "dialogs": [
                    {
                        "char": "说话角色名",
                        "text": "台词",
                        "emotion": "情绪：平静|激动|愤怒|悲伤|惊喜|紧张|冷漠|温柔",
                    }
                ],
            },
        ],
    }
    user_prompt = await render_prompt(
        "script",
        {
            "jsonSchema": json.dumps(schema, ensure_ascii=False, indent=2),
            "number": str(outline["number"]),
            "charDesc": char_desc,
            "outlineJson": json.dumps(outline, ensure_ascii=False, indent=2),
            "perChapterText": per_chapter[:6000],
        },
        project_id,
    )

    parsed = await _llm_json(
        db,
        [
            {"role": "system", "content": "你是漫剧分集编剧，只输出 JSON。"},
            {"role": "user", "content": user_prompt},
        ],
    )

    if parsed and isinstance(as_record(parsed).get("scenes"), list):
        r = as_record(parsed)
        ep: dict[str, Any] = {
            "number": int(
                as_string(r.get("number"), str(episode_number)) or episode_number
            ),
            "title": as_string(r.get("title"), outline.get("title", "")),
            "hookEnd": as_string(r.get("hookEnd"), outline.get("hookEnd", "")),
            "scenes": [],
        }
        for s in r["scenes"]:
            sr = as_record(s)
            dialogs_raw = sr.get("dialogs")
            dialogs = []
            if isinstance(dialogs_raw, list):
                for d in dialogs_raw:
                    dr = as_record(d)
                    dialogs.append(
                        {
                            "char": as_string(dr.get("char")),
                            "text": as_string(dr.get("text")),
                            "emotion": as_string(dr.get("emotion"), "平静"),
                        }
                    )
            ep["scenes"].append(
                {
                    "location": as_string(sr.get("location"), "主线场景"),
                    "time": as_string(sr.get("time"), "日"),
                    "characters": as_string_array(sr.get("characters")),
                    "action": as_string(sr.get("action"), ""),
                    "dialogs": dialogs,
                }
            )
    else:
        # 回退：用大纲场景生成基础剧本
        ep = {
            "number": episode_number,
            "title": outline.get("title", f"第{episode_number}集"),
            "hookEnd": outline.get("hookEnd", "悬念待定"),
            "scenes": [
                {
                    "location": s.get("location", "主线场景"),
                    "time": s.get("time", "日"),
                    "characters": [c.name for c in characters[:3]],
                    "action": f"{s.get('summary', '')}（本场景为启发式生成，配置 LLM Key 后重新生成可获高质量剧本）",
                    "dialogs": [
                        {
                            "char": characters[0].name,
                            "text": s.get("summary", ""),
                            "emotion": "平静",
                        }
                    ]
                    if characters
                    else [],
                }
                for s in outline.get("scenes", [])
            ],
        }

    # 落库：更新 Script.content.episodes[number-1]（列表不足时自动补齐占位）
    sid = await _script_id(db, project_id)
    script = (await db.execute(select(Script).where(Script.id == sid))).scalar_one()
    prev = dict(
        as_record(script.content)
    )  # 顶层拷贝：避免原地改+同引用赋值，SQLAlchemy 检测不到变更
    episodes = list(
        prev.get("episodes") or []
    )  # 列表也必须拷贝：否则改嵌套 list 时旧值共享同一引用，flush 时对比相等不发 UPDATE
    target = ep["number"] - 1
    while len(episodes) <= target:
        episodes.append({})
    episodes[target] = ep
    prev["episodes"] = episodes
    script.content = prev
    await db.flush()

    # Episode 行
    existing = (
        (
            await db.execute(
                select(Episode).where(
                    Episode.project_id == project_id,
                    Episode.number == ep["number"],
                )
            )
        )
        .scalars()
        .first()
    )
    if existing:
        existing.title = ep["title"]
        existing.hook_end = ep["hookEnd"]
    else:
        db.add(
            Episode(
                project_id=project_id,
                number=ep["number"],
                title=ep["title"],
                hook_end=ep["hookEnd"],
                status="draft",
            )
        )
    await db.flush()
    await _set_stage(db, project_id, "script")
    return ep


# ========== 分镜 Agent（M3 场景→镜头切分） ==========


async def run_storyboard(
    db: AsyncSession, project_id: str, episode_number: int
) -> dict[str, Any]:
    """把第 N 集剧本场景切分为镜头并组装 7 维提示词，写入 Shot 表。"""
    from app.storyboard.index import assemble_shot_prompts
    from app.models import Shot

    text, meta = await _get_novel(db, project_id)
    script = (
        (
            await db.execute(
                select(Script)
                .where(Script.project_id == project_id)
                .order_by(Script.version.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    content = as_record(script.content) if script else {}
    episodes = content.get("episodes") or []
    ep_script = next(
        (
            e
            for e in episodes
            if isinstance(e, dict) and e.get("number") == episode_number
        ),
        None,
    )
    if not ep_script:
        raise ValueError(f"第{episode_number}集剧本不存在，请先生成单集剧本")

    # 清空该集旧镜头
    episode = (
        (
            await db.execute(
                select(Episode).where(
                    Episode.project_id == project_id,
                    Episode.number == episode_number,
                )
            )
        )
        .scalars()
        .first()
    )
    if not episode:
        raise ValueError("该集不存在")
    await db.execute(delete(Shot).where(Shot.episode_id == episode.id))
    await db.flush()

    scenes: list[dict] = ep_script.get("scenes", [])
    total = len(scenes)
    seq = 0
    for i, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            continue
        scene_loc = as_string(scene.get("location"), "主线场景")
        scene_time = as_string(scene.get("time"), "日")
        scene_chars = as_string_array(scene.get("characters"))
        scene_action = as_string(scene.get("action"), "")
        scene_dialogs = scene.get("dialogs") or []
        scene_dialogs_str = "\n".join(
            f"{d.get('char', '')}（{d.get('emotion', '平静')}）：{d.get('text', '')}"
            for d in scene_dialogs
            if isinstance(d, dict)
        )
        # 角色外观参考
        characters = (
            (
                await db.execute(
                    select(Character).where(Character.project_id == project_id)
                )
            )
            .scalars()
            .all()
        )
        char_lines = "\n".join(
            f"{c.name}：{json.dumps(as_record(c.appearance), ensure_ascii=False)}"
            for c in characters[:6]
        )

        user_prompt = await render_prompt(
            "storyboard",
            {
                "index": str(i + 1),
                "total": str(total),
                "sceneLocation": scene_loc,
                "sceneTime": scene_time,
                "sceneChars": "、".join(scene_chars),
                "sceneAction": scene_action,
                "sceneDialogs": scene_dialogs_str,
                "charLines": char_lines,
            },
            project_id,
        )

        parsed = await _llm_json(
            db,
            [
                {"role": "system", "content": "你是漫剧分镜师，只输出 JSON。"},
                {"role": "user", "content": user_prompt},
            ],
        )

        shots_out: list[dict] = []
        if parsed:
            raw_shots = as_record(parsed).get("shots")
            if isinstance(raw_shots, list):
                for sh in raw_shots:
                    r = as_record(sh)
                    camera = as_record(r.get("camera"))
                    shots_out.append(
                        {
                            "sceneName": as_string(r.get("sceneName"), scene_loc),
                            "camera": {
                                "angle": as_string(camera.get("angle"), "平视"),
                                "movement": as_string(camera.get("movement"), "固定"),
                                "shotSize": as_string(camera.get("shotSize"), "中景"),
                            },
                            "action": as_string(r.get("action"), ""),
                            "dialog": as_string(r.get("dialog")) or None,
                            "dialogChar": as_string(r.get("dialogChar")) or None,
                            "dialogEmotion": as_string(r.get("dialogEmotion")) or None,
                            "duration": float(as_string(r.get("duration"), "5") or 5)
                            or 5.0,
                        }
                    )
        # 回退：无 LLM 输出时直接按场景生成单镜头
        if not shots_out:
            # 从剧本场景的 dialogs 取第一句台词（启发式剧本回退会生成 dialog），否则该镜头无台词
            first_dialog = None
            first_char = None
            first_emotion = None
            dialogs_raw = scene.get("dialogs")
            if isinstance(dialogs_raw, list):
                for d in dialogs_raw:
                    if isinstance(d, dict) and as_string(d.get("text")):
                        first_dialog = as_string(d.get("text"))
                        first_char = as_string(d.get("char")) or None
                        first_emotion = as_string(d.get("emotion"), "平静")
                        break
            shots_out.append(
                {
                    "sceneName": scene_loc,
                    "camera": {"angle": "平视", "movement": "固定", "shotSize": "中景"},
                    "action": scene_action or "（画面描述缺失）",
                    "dialog": first_dialog,
                    "dialogChar": first_char,
                    "dialogEmotion": first_emotion,
                    "duration": 5.0,
                }
            )

        for sh in shots_out:
            seq += 1
            db.add(
                Shot(
                    episode_id=episode.id,
                    sequence=seq,
                    scene_name=sh["sceneName"],
                    camera=sh["camera"],
                    action=sh["action"],
                    dialog=sh["dialog"],
                    dialog_char=sh["dialogChar"],
                    dialog_emotion=sh["dialogEmotion"],
                    duration=sh["duration"],
                    status="PENDING",
                )
            )
        await db.flush()

    # 组装 7 维提示词 + 锁定参考图
    n = await assemble_shot_prompts(db, project_id, episode.id)
    return {"episodeNumber": episode_number, "shots": n}


# ========== 阶段查询 ==========


async def get_script_stage(db: AsyncSession, project_id: str) -> str:
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not project:
        return "none"
    # 优先读独立的 script_stage 列；回退到 novel_meta.stage（兼容旧数据）
    stage = as_string(project.script_stage)
    if stage not in ("characters", "outline", "script"):
        meta = as_record(project.novel_meta)
        stage = as_string(meta.get("stage"))
    if stage not in ("characters", "outline", "script"):
        return "characters" if project.novel_text else "none"
    return stage
