import { NextRequest, NextResponse } from "next/server";
import { memoryStore } from "@/lib/storage";
import { ParseRule } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ rules: memoryStore.listRules() });
}

export async function POST(request: NextRequest) {
  const rule = (await request.json()) as ParseRule;
  const saved = memoryStore.saveRule({
    ...rule,
    updatedAt: new Date().toISOString()
  });
  return NextResponse.json({ rule: saved });
}
