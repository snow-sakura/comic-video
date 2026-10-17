"""提示词模板管理 API — /api/prompt-templates

GET    ?projectId=x — 全部模板定义：内置默认 + 全局行 + 项目行 + 生效文本
PUT    { key, scope, projectId?, template, name?, enabled? } — 保存（upsert）
DELETE ?key=&scope=&projectId= — 删除一条（恢复下一优先级）
POST   { key, projectId?, currentTemplate?, extraHint? } — AI 自动配置建议（不落库）
"""

from __future__ import annotations

import json
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.providers.registry import get_text_llm
from app.providers.base import LLMOptions
from app.prompts.registry import (
    PROMPT_TEMPLATES,
    is_prompt_key,
    get_prompt_template,
    upsert_prompt_template,
    delete_prompt_template,
)

router = APIRouter()


async def _list_rows(db: AsyncSession, project_id: str | None) -> dict[str, list]:
    """读取 global / project 模板行（供 GET 组装）"""
    from app.models import PromptTemplate
    from sqlalchemy import select

    global_rows = (
        (
            await db.execute(
                select(PromptTemplate).where(PromptTemplate.scope == "global")
            )
        )
        .scalars()
        .all()
    )
    project_rows = []
    if project_id:
        project_rows = (
            (
                await db.execute(
                    select(PromptTemplate).where(
                        PromptTemplate.scope == "project",
                        PromptTemplate.project_id == project_id,
                    )
                )
            )
            .scalars()
            .all()
        )

    def row_as_dict(r) -> dict:
        return {
            "key": r.key,
            "scope": r.scope,
            "projectId": r.project_id,
            "name": r.name,
            "template": r.template,
            "enabled": r.enabled,
        }

    return {
        "global": [row_as_dict(r) for r in global_rows],
        "project": [row_as_dict(r) for r in project_rows],
    }


@router.get("/prompt-templates")
async def get_templates(req: Request, db: AsyncSession = Depends(get_db)):
    project_id = req.query_params.get("projectId")
    rows = await _list_rows(db, project_id)

    result = []
    for key, defn in PROMPT_TEMPLATES.items():
        g = next((r for r in rows["global"] if r["key"] == key), None)
        p = next((r for r in rows["project"] if r["key"] == key), None)
        result.append(
            {
                "key": key,
                "name": defn["name"],
                "desc": defn["desc"],
                "variables": defn["variables"],
                "defaultTemplate": defn["defaultTemplate"],
                "global": (
                    {
                        "template": g["template"],
                        "enabled": g["enabled"],
                        "name": g["name"],
                    }
                    if g
                    else None
                ),
                "project": (
                    {
                        "template": p["template"],
                        "enabled": p["enabled"],
                        "name": p["name"],
                    }
                    if p
                    else None
                ),
                "effective": await get_prompt_template(key, project_id),
            }
        )
    return json.loads(json.dumps({"templates": result}))


@router.put("/prompt-templates")
async def put_template(req: Request, db: AsyncSession = Depends(get_db)):
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "JSON 解析失败")
    key = body.get("key", "")
    scope = body.get("scope", "")
    if not is_prompt_key(key):
        raise HTTPException(400, "key 必须是已注册的模板 key")
    if scope not in ("global", "project"):
        raise HTTPException(400, "scope 必须是 global | project")
    project_id = body.get("projectId")
    if scope == "project" and not project_id:
        raise HTTPException(400, "项目级模板必须提供 projectId")
    template = body.get("template")
    if not isinstance(template, str) or not template.strip():
        raise HTTPException(400, "template 不能为空")

    row = await upsert_prompt_template(
        key,
        scope,
        template,
        project_id=project_id,
        name=body.get("name"),
        enabled=body.get("enabled", True),
    )
    return {"ok": True, "row": row}


@router.delete("/prompt-templates")
async def delete_template(req: Request, db: AsyncSession = Depends(get_db)):
    key = req.query_params.get("key", "")
    scope = req.query_params.get("scope", "")
    project_id = req.query_params.get("projectId")
    if not is_prompt_key(key):
        raise HTTPException(400, "key 无效")
    if scope not in ("global", "project"):
        raise HTTPException(400, "scope 无效")
    await delete_prompt_template(key, scope, project_id)
    return {"ok": True}


@router.post("/prompt-templates")
async def ai_suggest_template(req: Request, db: AsyncSession = Depends(get_db)):
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "JSON 解析失败")
    key = body.get("key", "")
    if not is_prompt_key(key):
        raise HTTPException(400, "key 必须是已注册的模板 key")

    from app.models import Project
    from sqlalchemy import select

    project_id = body.get("projectId")
    project = None
    novel_text = ""
    if project_id:
        project = (
            await db.execute(select(Project).where(Project.id == project_id))
        ).scalar_one_or_none()
        if not project:
            raise HTTPException(404, "项目不存在")
        novel_text = project.novel_text or ""

    plot_sample = (
        f"{novel_text[:1500]}" + ("\n……（节选）" if len(novel_text) > 1500 else "")
        if novel_text
        else "（未上传小说，按通用风格定制）"
    )

    defn = PROMPT_TEMPLATES[key]
    current = body.get("currentTemplate") or await get_prompt_template(key, project_id)

    llm = get_text_llm()
    user_msg = "\n".join(
        [
            "请针对当前漫剧项目定制优化以下提示词模板，使其更贴合本项目的小说剧情与创作偏好。",
            "",
            "## 模板用途",
            f"{defn['name']}：{defn['desc']}",
            "",
            "## 可用变量（必须全部保留在输出中，不得删除或改名，{变量} 形式不变）",
            "\n".join(f"- {{{v['name']}}}：{v['desc']}" for v in defn["variables"]),
            "",
            "## 当前模板",
            current,
            "",
            "## 小说剧情（前 1500 字节选）",
            plot_sample,
            (
                f"\n## 用户附加要求\n{body['extraHint']}"
                if body.get("extraHint")
                else ""
            ),
            "",
            "## 任务",
            "1. 重写模板正文（保留全部 {变量} 占位符）",
            "2. 融入剧情风格：题材气质、情感基调、视觉偏好、台词风格",
            "3. 保持原有结构完整（JSON 约束、负面约束、镜头/出图要求等）",
            "4. 直接输出重写后的模板正文，不要任何解释、不要 markdown 代码块",
        ]
    )
    try:
        raw = await llm.chat(
            [
                {
                    "role": "system",
                    "content": "你是漫剧 AI 生成流水线的提示词工程专家，擅长优化给 LLM/图像/视频模型的提示词模板。",
                },
                {"role": "user", "content": user_msg},
            ],
            LLMOptions(json=False, temperature=0.6, max_tokens=6000),
        )
    except Exception as e:
        raise HTTPException(502, f"AI 生成失败: {e}")

    suggested = (raw or "").strip()
    if suggested.startswith("```"):
        suggested = suggested.strip("`").lstrip("texttxt").strip()
    if not suggested:
        raise HTTPException(502, "AI 生成失败，请重试")
    return {"ok": True, "key": key, "suggested": suggested, "defName": defn["name"]}
