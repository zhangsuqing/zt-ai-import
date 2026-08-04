const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const filePath = process.env.PERF_FILE ?? path.join(process.cwd(), "test-data", "10000-orders.xlsx");

function readExcelAsExtractedFile() {
  const book = XLSX.readFile(filePath, { cellDates: false });
  const sheets = book.SheetNames.map((name) => {
    const ws = book.Sheets[name];
    return { name, rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) };
  });
  return {
    fileName: path.basename(filePath),
    fileType: "excel",
    sheets,
    text: sheets.map((sheet) => `${sheet.name}\n${sheet.rows.slice(0, 20).map((row) => row.join("\t")).join("\n")}`).join("\n\n")
  };
}

function buildRule(fileName) {
  return {
    id: "perf-v4-rule",
    name: "V4 压测通用表格规则",
    description: "基于 V2 规则引擎的压测规则，不按文件名或固定行号硬编码。",
    sourceKind: "table",
    sheetMode: "all",
    headerRow: 1,
    dataStartRow: 2,
    groupBy: "externalCode",
    mappings: [
      { target: "externalCode", source: "外部编码", confidence: 1 },
      { target: "storeName", source: "收货门店", confidence: 1 },
      { target: "receiverName", source: "收件人姓名", confidence: 1 },
      { target: "receiverPhone", source: "收件人电话", confidence: 1 },
      { target: "receiverAddress", source: "收件人地址", confidence: 1 },
      { target: "skuCode", source: "SKU物品编码", confidence: 1 },
      { target: "skuName", source: "SKU物品名称", confidence: 1 },
      { target: "quantity", source: "SKU发货数量", confidence: 1, transform: "number" },
      { target: "skuSpec", source: "SKU规格型号", confidence: 1 },
      { target: "remark", source: "备注", confidence: 1 }
    ],
    skipPatterns: ["合计", "总计"],
    createdBy: "system",
    updatedAt: new Date().toISOString(),
    staticValues: { temperature: "常温" },
    metadata: { labels: {}, titleExternalCodePattern: fileName }
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

async function main() {
  if (!fs.existsSync(filePath)) throw new Error(`压测文件不存在：${filePath}`);
  const file = readExcelAsExtractedFile();
  const rule = buildRule(file.fileName);

  const uploadStarted = Date.now();
  const created = await postJson(`${baseUrl}/api/import-tasks`, { file, rule, batchSize: Number(process.env.BATCH_SIZE ?? 1000) });
  const uploadMs = Date.now() - uploadStarted;
  const started = Date.now();
  let state = created;
  let httpErrors = 0;

  while (!["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(state.status)) {
    try {
      await postJson(`${baseUrl}/api/import-worker/dispatch?limit=${process.env.DISPATCH_LIMIT ?? 8}`, {});
      const res = await fetch(`${baseUrl}/api/import-tasks/${created.task_id}`);
      if (!res.ok) httpErrors += 1;
      state = await res.json();
      process.stdout.write(`\r${state.status} ${state.processed_rows}/${state.total_rows} success=${state.success_rows} failed=${state.failed_rows}`);
    } catch (error) {
      httpErrors += 1;
      console.error("\n轮询/调度失败：", error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const totalMs = Date.now() - started;
  console.log("\n压测结果");
  console.log(JSON.stringify({
    task_id: created.task_id,
    trace_id: created.trace_id,
    upload_ms: uploadMs,
    total_ms: totalMs,
    status: state.status,
    total_rows: state.total_rows,
    success_rows: state.success_rows,
    failed_rows: state.failed_rows,
    http_errors: httpErrors,
    pass_upload_p95_goal_single_sample: uploadMs <= 1000,
    pass_total_goal: totalMs <= 60000
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
