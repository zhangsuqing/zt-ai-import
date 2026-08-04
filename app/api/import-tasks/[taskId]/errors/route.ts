import { NextRequest, NextResponse } from "next/server";
import { importStore } from "@/lib/import-storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const { searchParams } = new URL(request.url);
  const errors = await importStore.listErrors(taskId, {
    batch: searchParams.get("batch") ? Number(searchParams.get("batch")) : undefined,
    errorCode: searchParams.get("error_code") ?? undefined,
    page: Number(searchParams.get("page") ?? 1),
    pageSize: Number(searchParams.get("page_size") ?? 50)
  });
  return NextResponse.json({ task_id: taskId, errors });
}
