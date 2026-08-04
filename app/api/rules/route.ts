import { NextRequest, NextResponse } from "next/server";
import { normalizeParseRule } from "@/lib/rule-engine";
import { store } from "@/lib/storage";
import { ParseRule } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ rules: await store.listRules(), database: store.isDatabaseEnabled() });
}

export async function POST(request: NextRequest) {
  const rule = normalizeParseRule((await request.json()) as Partial<ParseRule>);
  const saved = await store.saveRule({
    ...rule,
    updatedAt: new Date().toISOString()
  });
  return NextResponse.json({ rule: saved, database: store.isDatabaseEnabled() });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  await store.deleteRule(id);
  return NextResponse.json({ success: true, database: store.isDatabaseEnabled() });
}
