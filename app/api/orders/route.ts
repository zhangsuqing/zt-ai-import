import { NextRequest, NextResponse } from "next/server";
import { memoryStore } from "@/lib/storage";
import { OrderRow } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get("keyword")?.trim() ?? "";
  const rows = memoryStore.listOrders().filter((row) => {
    if (!keyword) return true;
    return [row.externalCode, row.receiverName, row.storeName, row.receiverPhone].some((value) => value.includes(keyword));
  });

  return NextResponse.json({ rows });
}

export async function POST(request: NextRequest) {
  const rows = (await request.json()) as OrderRow[];
  const saved = memoryStore.saveOrders(rows);
  return NextResponse.json({
    success: saved.length,
    failed: 0,
    rows: saved
  });
}
