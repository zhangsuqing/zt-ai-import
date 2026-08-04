import { NextRequest, NextResponse } from "next/server";
import { importStore } from "@/lib/import-storage";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const task = await importStore.getTask(taskId);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const batches = await importStore.getBatches(taskId);
  const recentErrors = await importStore.listErrors(taskId, { page: 1, pageSize: 10 });
  return NextResponse.json({
    task_id: task.id,
    trace_id: task.traceId,
    status: task.status,
    total_rows: task.totalRows,
    processed_rows: task.processedRows,
    success_rows: task.successRows,
    failed_rows: task.failedRows,
    total_batches: task.totalBatches,
    completed_batches: task.completedBatches,
    degraded: task.degraded,
    warning: task.warning,
    progress: task.totalRows ? Math.round((task.processedRows / task.totalRows) * 100) : 0,
    batches,
    recent_errors: recentErrors
  });
}
