const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const XLSX = require("xlsx");

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("v4 required files are present", () => {
  [
    "lib/import-storage.ts",
    "lib/import-worker.ts",
    "app/api/import-tasks/route.ts",
    "app/api/import-worker/dispatch/route.ts",
    "app/api/import-monitor/summary/route.ts",
    "app/api/traces/route.ts",
    "scripts/seed-v4-data.cjs",
    "scripts/perf-v4-import.cjs",
    "docs/v4-refactor-assumptions.md",
    "docs/v4-api.md",
    "docs/v4-performance-report.md"
  ].forEach((file) => assert.ok(fs.existsSync(path.join(root, file)), `${file} missing`));
});

test("10000 row pressure file is available", () => {
  const file = path.join(root, "test-data", "10000-orders.xlsx");
  assert.ok(fs.existsSync(file), "test-data/10000-orders.xlsx missing");
  const book = XLSX.readFile(file, { sheetRows: 10020 });
  const sheet = book.Sheets[book.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
  assert.ok(rows.length >= 10001, `expected header + 10000 rows, got ${rows.length}`);
});

test("task creation uses transactional outbox and batch storage", () => {
  const storage = read("lib/import-storage.ts");
  assert.match(storage, /client\.query\("BEGIN"\)/);
  assert.match(storage, /INSERT INTO import_tasks/);
  assert.match(storage, /INSERT INTO import_task_batches/);
  assert.match(storage, /INSERT INTO event_outbox/);
  assert.match(storage, /COMMIT/);
});

test("worker uses batch validation, bulk write, idempotent claim, and stale recovery", () => {
  const storage = read("lib/import-storage.ts");
  const worker = read("lib/import-worker.ts");
  const orders = read("lib/storage.ts");
  assert.match(storage, /sku_code = ANY\(\$1::text\[\]\)/);
  assert.match(orders, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(storage, /status IN \('PENDING','QUEUED','FAILED'\) RETURNING id/);
  assert.match(storage, /recoverStaleBatches/);
  assert.match(worker, /if \(!claimed\)/);
});

test("observability APIs expose monitor stats and trace search", () => {
  const storage = read("lib/import-storage.ts");
  const tracesRoute = read("app/api/traces/route.ts");
  assert.match(storage, /throughputRowsPerMinute/);
  assert.match(storage, /stageStats/);
  assert.match(storage, /queueAlert/);
  assert.match(storage, /searchTraces/);
  assert.match(tracesRoute, /task_id/);
  assert.match(tracesRoute, /error_code/);
});
