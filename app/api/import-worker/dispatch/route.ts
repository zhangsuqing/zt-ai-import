import { NextRequest, NextResponse } from "next/server";
import { dispatchImportEvents } from "@/lib/import-worker";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit") ?? 4)));
  return NextResponse.json(await dispatchImportEvents(limit));
}

export async function GET(request: NextRequest) {
  return POST(request);
}
