/**
 * POST /api/tasks/[id]/retry — 重试失败/拒绝的任务
 */
import { NextResponse } from "next/server";
import { retryGenTask } from "@/lib/retry";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = await retryGenTask(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "重试失败" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, taskId: id });
}
