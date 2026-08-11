/**
 * POST /api/tasks/[id]/retry — 重试失败/拒绝的任务
 */
import { NextResponse } from "next/server";
import { retryGenTask } from "@/lib/retry";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const result = await retryGenTask(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "重试失败" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, taskId: id });
  } catch (e) {
    console.error(`[retry] 任务重试失败: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "任务重试失败" }, { status: 500 });
  }
}
