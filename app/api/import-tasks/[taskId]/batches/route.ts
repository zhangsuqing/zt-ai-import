import { NextRequest, NextResponse } from "next/server";
import { importStore } from "@/lib/import-storage";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const [batches, performance] = await Promise.all([
    importStore.getBatches(taskId),
    importStore.listPerformance(taskId)
  ]);
  return NextResponse.json({ task_id: taskId, batches, performance });
}
