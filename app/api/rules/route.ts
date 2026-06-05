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
