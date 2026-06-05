import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/storage";
import { ParseRule } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ rules: await store.listRules(), database: store.isDatabaseEnabled() });
}

export async function POST(request: NextRequest) {
  const rule = (await request.json()) as ParseRule;
  const saved = await store.saveRule({
    ...rule,
    updatedAt: new Date().toISOString()
  });
  return NextResponse.json({ rule: saved, database: store.isDatabaseEnabled() });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少规则 ID" }, { status: 400 });
  await store.deleteRule(id);
  return NextResponse.json({ ok: true, database: store.isDatabaseEnabled() });
}
