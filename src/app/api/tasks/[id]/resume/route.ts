/**
 * POST /api/tasks/[id]/resume — 恢复暂停的任务（PAUSED → QUEUED 并重新入队）
 * payload 由 retry.ts 的 resumeGenTask 从业务表完整重建（不依赖残缺的 input 快照）。
 * 若流水线全局处于暂停状态，会自动恢复流水线（否则入队后 worker 不消费，任务依然不会执行）
 */
import { NextResponse } from "next/server";
import { resumeGenTask } from "@/lib/retry";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const result = await resumeGenTask(id);
    if (!result.ok) {
      // 任务不存在 → 404；其余为业务参数错误 → 400
      return NextResponse.json({ error: result.error ?? "任务恢复失败" }, { status: result.error === "任务不存在" ? 404 : 400 });
    }
    return NextResponse.json({ ok: true, taskId: id });
  } catch (e) {
    console.error(`[resume] 任务恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "任务恢复失败" }, { status: 500 });
  }
}
