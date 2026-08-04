import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/storage";
import { OrderRow } from "@/lib/types";

export const runtime = "nodejs";

type WaybillDto = {
  waybillNo: string;
  externalCode: string;
  storeName: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  amount: number;
  source: "v2";
  items: Array<{ skuCode: string; skuName: string; quantity: number; skuSpec: string; remark: string }>;
  rows: OrderRow[];
};

function toNumber(value: number | string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupRows(rows: OrderRow[]) {
  const groups = new Map<string, OrderRow[]>();
  for (const row of rows) {
    if (!row.externalCode) continue;
    const list = groups.get(row.externalCode) ?? [];
    list.push(row);
    groups.set(row.externalCode, list);
  }
  return Array.from(groups.entries()).map(([externalCode, list]): WaybillDto => {
    const first = list[0];
    return {
      waybillNo: externalCode,
      externalCode,
      storeName: first.storeName,
      receiverName: first.receiverName,
      receiverPhone: first.receiverPhone,
      receiverAddress: first.receiverAddress,
      amount: list.reduce((sum, row) => sum + toNumber(row.quantity) * 20, 0),
      source: "v2",
      items: list.map((row) => ({
        skuCode: row.skuCode,
        skuName: row.skuName,
        quantity: toNumber(row.quantity),
        skuSpec: row.skuSpec,
        remark: row.remark
      })),
      rows: list
    };
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const waybillNo = searchParams.get("waybillNo")?.trim() ?? "";
  const keyword = searchParams.get("keyword")?.trim() ?? waybillNo;
  const rows = await store.listOrders(keyword);
  const waybills = groupRows(rows).filter((item) => !waybillNo || item.externalCode === waybillNo);
  return NextResponse.json({
    success: true,
    apiVersion: "v1",
    database: store.isDatabaseEnabled(),
    data: { waybills },
    rows: waybills.flatMap((item) => item.rows)
  });
}
