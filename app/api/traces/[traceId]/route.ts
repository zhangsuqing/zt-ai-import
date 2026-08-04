import { NextRequest, NextResponse } from "next/server";
import { importStore } from "@/lib/import-storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  const { searchParams } = new URL(request.url);
  const hasFilters = ["task_id", "file_name", "batch", "row_from", "row_to", "error_code"].some((key) => searchParams.has(key));
  const events = hasFilters
    ? await importStore.searchTraces({
      traceId,
      taskId: searchParams.get("task_id") ?? undefined,
      fileName: searchParams.get("file_name") ?? undefined,
      batch: searchParams.get("batch") ? Number(searchParams.get("batch")) : undefined,
      rowFrom: searchParams.get("row_from") ? Number(searchParams.get("row_from")) : undefined,
      rowTo: searchParams.get("row_to") ? Number(searchParams.get("row_to")) : undefined,
      errorCode: searchParams.get("error_code") ?? undefined
    })
    : await importStore.listTraces(traceId);
  return NextResponse.json({ trace_id: traceId, events });
}
