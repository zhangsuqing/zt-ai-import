import { NextResponse } from "next/server";
import { importStore } from "@/lib/import-storage";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await importStore.monitorSummary());
}
