import { NextRequest, NextResponse } from "next/server";
import { importStore } from "@/lib/import-storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const events = await importStore.searchTraces({
    traceId: searchParams.get("trace_id") ?? undefined,
    taskId: searchParams.get("task_id") ?? undefined,
    fileName: searchParams.get("file_name") ?? undefined,
    batch: searchParams.get("batch") ? Number(searchParams.get("batch")) : undefined,
    rowFrom: searchParams.get("row_from") ? Number(searchParams.get("row_from")) : undefined,
    rowTo: searchParams.get("row_to") ? Number(searchParams.get("row_to")) : undefined,
    errorCode: searchParams.get("error_code") ?? undefined
  });
  return NextResponse.json({ events });
}
