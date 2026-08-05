import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/storage";
import { OrderRow } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get("keyword")?.trim() ?? "";
  if (searchParams.get("mode") === "groups") {
    const page = Number(searchParams.get("page") ?? 1);
    const pageSize = Number(searchParams.get("pageSize") ?? 10);
    const result = await store.listOrderGroups(keyword, page, pageSize);
    return NextResponse.json({ ...result, database: store.isDatabaseEnabled() });
  }
  const rows = await store.listOrders(keyword);

  return NextResponse.json({ rows, database: store.isDatabaseEnabled() });
}

export async function POST(request: NextRequest) {
  const rows = (await request.json()) as OrderRow[];
  const saved = await store.saveOrdersBulk(rows);
  return NextResponse.json({
    success: saved.length,
    failed: 0,
    rows: saved,
    database: store.isDatabaseEnabled()
  });
}

export async function DELETE() {
  await store.clearOrders();
  return NextResponse.json({ success: true, database: store.isDatabaseEnabled() });
}
