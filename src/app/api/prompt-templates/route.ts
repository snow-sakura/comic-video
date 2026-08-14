/**
 * 提示词模板管理 API（提示词工程可视化配置）
 *
 * GET    /api/prompt-templates?projectId=x
 *        返回全部模板定义：内置默认 + 全局行 + 项目行 + 生效文本（项目覆盖>全局>内置）
 * PUT    { key, scope, projectId?, template, name?, enabled? }
 *        保存一条模板（upsert 语义）
 * DELETE { key, scope, projectId? }（query 参数）
 *        删除一条模板（恢复下一优先级）
 * POST   { key, projectId?, currentTemplate?, extraHint? }
 *        AI 自动配置：结合小说剧情生成定制模板（保留 {变量} 占位符），返回建议文本供用户确认保存
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getScriptLLM } from "@/lib/providers/registry";
import {
  PROMPT_TEMPLATE_MAP,
  getPromptTemplate,
  listPromptTemplates,
  upsertPromptTemplate,
  deletePromptTemplate,
  isPromptKey,
  type PromptKey,
} from "@/lib/prompts/registry";

function bad(msg: string, status = 400): NextResponse {
  return NextResponse.json({ error: msg }, { status });
}

/** GET：模板列表 + 生效值 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const rows = await listPromptTemplates(projectId);
  const withEffective = await Promise.all(
    rows.map(async (r) => ({
      key: r.key,
      name: r.name,
      desc: r.desc,
      variables: r.variables,
      defaultTemplate: r.defaultTemplate,
      global: r.global ? { template: r.global.template, enabled: r.global.enabled, name: r.global.name } : null,
      project: r.project ? { template: r.project.template, enabled: r.project.enabled, name: r.project.name } : null,
      effective: await getPromptTemplate(r.key, projectId),
    }))
  );
  return NextResponse.json({ templates: withEffective });
}

/** PUT：保存模板 */
export async function PUT(req: NextRequest) {
  let body: {
    key?: string;
    scope?: string;
    projectId?: string | null;
    template?: string;
    name?: string;
    enabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return bad("JSON 解析失败");
  }
  const { key, scope } = body;
  if (!key || !isPromptKey(key)) return bad("key 必须是已注册的模板 key");
  if (scope !== "global" && scope !== "project") return bad("scope 必须是 global | project");
  if (scope === "project" && !body.projectId) return bad("项目级模板必须提供 projectId");
  if (typeof body.template !== "string" || !body.template.trim()) return bad("template 不能为空");

  const row = await upsertPromptTemplate(key as PromptKey, scope, body.template, {
    projectId: body.projectId ?? null,
    name: body.name,
    enabled: body.enabled,
  });
  return NextResponse.json({ ok: true, row });
}

/** DELETE：删除模板（恢复下一优先级） */
export async function DELETE(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  const scope = req.nextUrl.searchParams.get("scope") ?? "";
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!isPromptKey(key)) return bad("key 无效");
  if (scope !== "global" && scope !== "project") return bad("scope 无效");
  await deletePromptTemplate(key as PromptKey, scope as "global" | "project", projectId);
  return NextResponse.json({ ok: true });
}

/** POST：AI 自动配置 —— 结合小说剧情生成定制模板（不落库，返回建议供确认） */
export async function POST(req: NextRequest) {
  let body: { key?: string; projectId?: string; currentTemplate?: string; extraHint?: string };
  try {
    body = await req.json();
  } catch {
    return bad("JSON 解析失败");
  }
  const key = body.key ?? "";
  if (!isPromptKey(key)) return bad("key 必须是已注册的模板 key");

  const projectId = body.projectId;
  const project = projectId
    ? await prisma.project.findUnique({ where: { id: projectId } })
    : null;
  if (projectId && !project) return bad("项目不存在", 404);

  // 小说剧情素材：摘要 + 前文（供 LLM 定制时贴合剧情）
  const novelText = project?.novelText ?? "";
  const plotSample = novelText
    ? `${novelText.slice(0, 1500)}${novelText.length > 1500 ? "\n……（节选）" : ""}`
    : "（未上传小说，按通用风格定制）";

  const def = PROMPT_TEMPLATE_MAP[key as PromptKey];
  const currentTemplate = body.currentTemplate || (await getPromptTemplate(key as PromptKey, projectId));

  const llm = await getScriptLLM();
  const raw = await llm.chat(
    [
      { role: "system", content: "你是漫剧 AI 生成流水线的提示词工程专家，擅长优化给 LLM/图像/视频模型的提示词模板。" },
      {
        role: "user",
        content: [
          `请针对当前漫剧项目定制优化以下提示词模板，使其更贴合本项目的小说剧情与创作偏好。`,
          ``,
          `## 模板用途`,
          `${def.name}：${def.desc}`,
          ``,
          `## 可用变量（必须全部保留在输出中，不得删除或改名，{变量} 形式不变）`,
          def.variables.map((v) => `- {${v.name}}：${v.desc}`).join("\n"),
          ``,
          `## 当前模板`,
          currentTemplate,
          ``,
          `## 小说剧情（前 1500 字节选）`,
          plotSample,
          body.extraHint ? `\n## 用户附加要求\n${body.extraHint}` : "",
          ``,
          `## 任务`,
          `1. 重写模板正文（保留全部 {变量} 占位符）`,
          `2. 融入剧情风格：题材气质、情感基调、视觉偏好、台词风格`,
          `3. 保持原有结构完整（JSON 约束、负面约束、镜头/出图要求等）`,
          `4. 直接输出重写后的模板正文，不要任何解释、不要 markdown 代码块`,
        ].join("\n"),
      },
    ],
    { json: false, temperature: 0.6, maxTokens: 6000 }
  );

  const suggested = (raw ?? "").trim().replace(/^```(?:text|txt)?/i, "").replace(/```$/, "").trim();
  if (!suggested) return bad("AI 生成失败，请重试", 502);
  return NextResponse.json({ ok: true, key, suggested, defName: def.name });
}
