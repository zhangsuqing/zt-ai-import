const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createPool } = require("@vercel/postgres");

const root = process.cwd();
const testDataDir = path.join(root, "test-data");
const publicDir = path.join(root, "public");
const envPath = path.join(root, ".env.local");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const clean = line.replace(/^\uFEFF/, "").trim();
    if (!clean || clean.startsWith("#")) continue;
    const index = clean.indexOf("=");
    if (index <= 0) continue;
    const key = clean.slice(0, index).trim().replace(/^export\s+/, "");
    const value = clean.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function makeSku(index) {
  const code = `SKU_${String(index).padStart(5, "0")}`;
  return {
    id: `sku_${String(index).padStart(5, "0")}`,
    sku_code: code,
    name: `压测商品 ${index}`,
    spec: `${(index % 12) + 1}kg/箱`,
    unit: "箱"
  };
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function findColumn(headers, labels) {
  const normalized = headers.map(text);
  for (const label of labels) {
    const exact = normalized.findIndex((header) => header.replace(/\*$/, "") === label);
    if (exact >= 0) return exact;
  }
  for (const label of labels) {
    const included = normalized.findIndex((header) => header.includes(label));
    if (included >= 0) return included;
  }
  return -1;
}

function collectDemoSkus() {
  if (!fs.existsSync(publicDir)) return [];
  const skuMap = new Map();
  const files = fs.readdirSync(publicDir).filter((name) => /\.xlsx?$/i.test(name));
  for (const fileName of files) {
    const book = XLSX.readFile(path.join(publicDir, fileName), { cellDates: false });
    for (const sheetName of book.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, raw: false, defval: "" });
      rows.forEach((row, rowIndex) => {
        const codeCol = findColumn(row, ["SKU物品编码", "SKU条码", "外部商品编码", "物品编码", "物品编码*"]);
        if (codeCol < 0) return;
        const nameCol = findColumn(row, ["SKU物品名称", "SKU名称", "物品名称", "商品名称"]);
        const specCol = findColumn(row, ["SKU规格型号", "规格型号", "规格", "型号"]);
        for (let index = rowIndex + 1; index < rows.length; index += 1) {
          const item = rows[index];
          const skuCode = text(item[codeCol]);
          if (!skuCode || skuCode === "合计" || skuCode.includes("调拨记录")) break;
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/.test(skuCode)) continue;
          skuMap.set(skuCode, {
            id: `sku_demo_${skuCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`,
            sku_code: skuCode,
            name: text(item[nameCol]) || skuCode,
            spec: text(item[specCol]),
            unit: "件"
          });
        }
      });
    }
  }
  return Array.from(skuMap.values());
}

async function seedSkuMaster() {
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    console.log("DATABASE_URL/POSTGRES_URL 未配置，跳过 sku_master 数据库灌入，仅生成 Excel。");
    return;
  }
  const pool = createPool({ connectionString });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sku_master (
      id TEXT PRIMARY KEY,
      sku_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      spec TEXT,
      unit TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS sku_master_sku_code_idx ON sku_master(sku_code)");
  const batchSize = 1000;
  for (let start = 1; start <= 20000; start += batchSize) {
    const rows = Array.from({ length: Math.min(batchSize, 20000 - start + 1) }, (_, offset) => makeSku(start + offset));
    await pool.query(
      `INSERT INTO sku_master (id, sku_code, name, spec, unit, created_at)
       SELECT id, sku_code, name, spec, unit, NOW()
       FROM jsonb_to_recordset($1::jsonb)
       AS x(id text, sku_code text, name text, spec text, unit text)
       ON CONFLICT (sku_code) DO UPDATE SET name = EXCLUDED.name, spec = EXCLUDED.spec, unit = EXCLUDED.unit`,
      [JSON.stringify(rows)]
    );
  }
  const demoSkus = collectDemoSkus();
  if (demoSkus.length) {
    await pool.query(
      `INSERT INTO sku_master (id, sku_code, name, spec, unit, created_at)
       SELECT id, sku_code, name, spec, unit, NOW()
       FROM jsonb_to_recordset($1::jsonb)
       AS x(id text, sku_code text, name text, spec text, unit text)
       ON CONFLICT (sku_code) DO UPDATE SET name = EXCLUDED.name, spec = EXCLUDED.spec, unit = EXCLUDED.unit`,
      [JSON.stringify(demoSkus)]
    );
  }
  await pool.end();
  console.log(`sku_master 已灌入/更新 20000 条压测 SKU，${demoSkus.length} 条 demo SKU。`);
}

function generateExcel() {
  fs.mkdirSync(testDataDir, { recursive: true });
  const rows = Array.from({ length: 10000 }, (_, index) => {
    const rowNo = index + 1;
    const skuNo = (rowNo % 997 === 0) ? 99999 : ((rowNo % 20000) + 1);
    return {
      "外部编码": `LOAD_${String(Math.ceil(rowNo / 3)).padStart(6, "0")}`,
      "收货门店": `压测门店 ${Math.ceil(rowNo / 3)}`,
      "收件人姓名": `收件人${rowNo}`,
      "收件人电话": `138${String(10000000 + rowNo).slice(-8)}`,
      "收件人地址": `上海市青浦区压测路 ${rowNo} 号`,
      "SKU物品编码": skuNo === 99999 ? `BAD_${rowNo}` : `SKU_${String(skuNo).padStart(5, "0")}`,
      "SKU物品名称": `压测商品 ${skuNo}`,
      "SKU发货数量": (rowNo % 9) + 1,
      "SKU规格型号": `${(skuNo % 12) + 1}kg/箱`,
      "备注": rowNo % 997 === 0 ? "故意非法 SKU" : ""
    };
  });
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(book, sheet, "orders");
  const out = path.join(testDataDir, "10000-orders.xlsx");
  XLSX.writeFile(book, out);
  console.log(`已生成 ${out}`);
}

seedSkuMaster()
  .then(generateExcel)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
