import { NextRequest, NextResponse } from "next/server";
import { importStore } from "@/lib/import-storage";
import { normalizeParseRule, parseWithRule } from "@/lib/rule-engine";
import { ExtractedFile, OrderRow, ParseRule } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    database: importStore.isDatabaseEnabled(),
    tasks: await importStore.listTasks(30)
  });
}

export async function POST(request: NextRequest) {
  const started = Date.now();
  try {
    const body = await request.json() as {
      file?: ExtractedFile;
      fileName?: string;
      rule: ParseRule;
      rows?: OrderRow[];
      batchSize?: number;
    };
    if ((!body.file && !Array.isArray(body.rows)) || !body.rule) {
      return NextResponse.json({ error: "file or rows, and rule are required" }, { status: 400 });
    }
    const rule = body.file ? normalizeParseRule(body.rule, body.file) : normalizeParseRule(body.rule);
    const rows = Array.isArray(body.rows) && body.rows.length ? body.rows : body.file ? parseWithRule(body.file, rule) : [];
    if (!rows.length) {
      return NextResponse.json({ error: "当前文件按已保存规则解析结果为 0 行，请先点击试解析确认规则。" }, { status: 400 });
    }
    const { task } = await importStore.createTask({
      fileName: body.fileName || body.file?.fileName || "manual-import",
      ruleId: rule.id,
      rows,
      batchSize: body.batchSize
    });
    return NextResponse.json({
      task_id: task.id,
      trace_id: task.traceId,
      status: task.status,
      total_rows: task.totalRows,
      total_batches: task.totalBatches,
      upload_duration_ms: Date.now() - started,
      database: importStore.isDatabaseEnabled()
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "create import task failed" }, { status: 400 });
  }
}

export async function DELETE() {
  await importStore.clearImportData();
  return NextResponse.json({ success: true, database: importStore.isDatabaseEnabled() });
}