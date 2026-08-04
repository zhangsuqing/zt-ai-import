import { CanonicalField, ExtractedFile, fieldLabels, OrderRow, ParseRule, RawCell, ValidationError } from "./types";

const normalize = (value: RawCell) => String(value ?? "").replace(/\s+/g, " ").trim();

const asNumber = (value: RawCell) => {
  const match = String(value ?? "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : "";
};

const hasText = (row: RawCell[]) => row.some((cell) => normalize(cell));

const itemHeaderWords = ["物品编码", "SKU物品编码", "SKU条码", "外部商品编码", "物品名称", "SKU名称", "出库数量", "发货数量", "数量"];
const matrixIgnoredColumns = ["下单后结余", "合计", "总计", "在库数量", "可用数量", "待移入", "分配数量", "冻结数量"];

const findColumn = (headers: RawCell[], source: string) => {
  const wanted = source.toLowerCase();
  const exact = headers.findIndex((header) => normalize(header).toLowerCase() === wanted);
  if (exact >= 0) return exact;
  return headers.findIndex((header) => normalize(header).toLowerCase().includes(wanted));
};

const makeId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
};

const canonicalFields = new Set<CanonicalField>(Object.keys(fieldLabels) as CanonicalField[]);
const sourceKinds = new Set(["table", "matrix", "cards", "textBlocks"]);
const sheetModes = new Set(["first", "all"]);

const asPositiveRow = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

const headerScore = (row: RawCell[]) => row.reduce<number>((score, cell) => {
  const text = normalize(cell);
  return score + (itemHeaderWords.some((word) => text.includes(word)) ? 1 : 0);
}, 0);

const findHeaderRow = (rows: RawCell[][]) => {
  let bestIndex = rows.findIndex((row) => row.filter((cell) => normalize(cell)).length >= 3);
  let bestScore = -1;
  rows.forEach((row, index) => {
    const score = headerScore(row);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex >= 0 ? bestIndex + 1 : 1;
};

const findValueAfterLabel = (rows: RawCell[][], labels: string[]) => {
  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = normalize(row[index]).replace(/\*$/, "");
      if (!labels.some((label) => cell === label || cell.includes(label))) continue;
      const next = normalize(row[index + 1]);
      if (next) return next;
    }
  }
  return "";
};

const extractStoreFromTitle = (sheetName: string, rows: RawCell[][]) => {
  const title = normalize(rows.find((row) => normalize(row[0]))?.[0]);
  const match = title.match(/(.+?)(?:出库单|配送发货单|调拨单)/);
  return match?.[1]?.replace(/[·\-]\s*$/, "").trim() || sheetName;
};

const sheetContext = (sheetName: string, rows: RawCell[][]) => ({
  externalCode: findValueAfterLabel(rows, ["单据号", "配送单号", "配送汇总单号", "调拨单号"]) || "",
  storeName: findValueAfterLabel(rows, ["收货机构", "订货机构", "调入门店"]) || extractStoreFromTitle(sheetName, rows),
  receiverName: findValueAfterLabel(rows, ["收货人", "收件人", "联系人"]),
  receiverPhone: findValueAfterLabel(rows, ["收货电话", "收件人电话", "电话"]),
  receiverAddress: findValueAfterLabel(rows, ["收货地址", "收件人地址", "地址"])
});

const enrichRow = (row: OrderRow, context: ReturnType<typeof sheetContext>, sheetName: string, rowIndex: number) => ({
  ...row,
  externalCode: row.externalCode || context.externalCode || `${sheetName}-${rowIndex + 1}`,
  storeName: row.storeName || context.storeName,
  receiverName: row.receiverName || context.receiverName,
  receiverPhone: row.receiverPhone || context.receiverPhone,
  receiverAddress: row.receiverAddress || context.receiverAddress
});

const applyStaticValues = (row: OrderRow, rule: ParseRule) => ({ ...row, ...(rule.staticValues ?? {}) });

const mapRow = (sourceRow: RawCell[], headers: RawCell[], rule: ParseRule, sheetName: string, rowIndex: number): OrderRow => {
  const row: OrderRow = {
    id: makeId(),
    externalCode: "",
    storeName: "",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    skuCode: "",
    skuName: "",
    quantity: "",
    skuSpec: "",
    temperature: "",
    remark: "",
    sourceSheet: sheetName,
    sourceRow: rowIndex + 1
  };

  rule.mappings.forEach((mapping) => {
    const idx = findColumn(headers, mapping.source);
    if (idx < 0) return;
    const raw = sourceRow[idx];
    const value = mapping.transform === "number" ? asNumber(raw) : normalize(raw);
    (row[mapping.target] as string | number) = value;
  });

  return applyStaticValues(row, rule);
};

const parseTable = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const sheets = rule.sheetMode === "all" ? file.sheets : file.sheets.slice(0, 1);
  return sheets.flatMap((sheet) => {
    const headerIndex = Math.max((rule.headerRow ?? 1) - 1, 0);
    const startIndex = Math.max((rule.dataStartRow ?? headerIndex + 2) - 1, headerIndex + 1);
    const headers = sheet.rows[headerIndex] ?? [];
    const context = sheetContext(sheet.name, sheet.rows);
    const rows = sheet.rows.slice(startIndex).filter(hasText);
    return rows
      .filter((row) => !rule.skipPatterns?.some((pattern) => normalize(row.join(" ")).includes(pattern)))
      .map((row, offset) => enrichRow(mapRow(row, headers, rule, sheet.name, startIndex + offset), context, sheet.name, startIndex + offset))
      .filter((row) => row.skuCode && row.skuName && Number(row.quantity) > 0);
  });
};

const parseMatrix = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const sheet = file.sheets[0];
  if (!sheet) return [];
  const headerIndex = Math.max((rule.headerRow ?? 1) - 1, 0);
  const headers = sheet.rows[headerIndex] ?? [];
  const valueStart = rule.matrix?.valueColumnsStartAt ?? 2;
  const baseHeaders = headers.slice(0, valueStart);
  const rows: OrderRow[] = [];

  sheet.rows.slice(headerIndex + 1).forEach((sourceRow, offset) => {
    if (!hasText(sourceRow)) return;
    headers.slice(valueStart).forEach((header, headerOffset) => {
      const value = sourceRow[valueStart + headerOffset];
      const columnName = normalize(header);
      if (!normalize(value) || !columnName || matrixIgnoredColumns.some((word) => columnName.includes(word))) return;
      const base = mapRow(sourceRow.slice(0, valueStart), baseHeaders, rule, sheet.name, headerIndex + 1 + offset);
      const quantity = asNumber(value);
      if (!quantity || Number(quantity) <= 0) return;
      rows.push({
        ...base,
        id: makeId(),
        externalCode: base.externalCode || `${columnName}-${offset + 1}-${headerOffset + 1}`,
        storeName: rule.matrix?.columnHeaderAs === "storeName" ? columnName : base.storeName,
        remark: rule.matrix?.columnHeaderAs === "date" ? `${base.remark} ${columnName}`.trim() : base.remark,
        quantity: quantity || normalize(value)
      });
    });
  });
  return rows;
};

const parseCards = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  return file.sheets.flatMap((sheet) => {
    const documentNo = findValueAfterLabel(sheet.rows, ["调拨单号", "单据号", "配送单号"]);
    const result: OrderRow[] = [];
    for (let index = 0; index < sheet.rows.length; index += 1) {
      const marker = normalize(sheet.rows[index]?.[0]);
      if (!marker.includes("调拨记录")) continue;
      const blockRows = sheet.rows.slice(index, Math.min(sheet.rows.length, index + 20));
      const context = sheetContext(sheet.name, blockRows);
      const itemHeaderIndex = blockRows.findIndex((row) => row.some((cell) => normalize(cell).includes("物品编码")));
      if (itemHeaderIndex < 0) continue;
      const headers = blockRows[itemHeaderIndex];
      const externalCode = `${documentNo || sheet.name}-${marker.replace(/[^\dA-Za-z#_-]/g, "") || index + 1}`;
      for (let rowOffset = itemHeaderIndex + 1; rowOffset < blockRows.length; rowOffset += 1) {
        const sourceRow = blockRows[rowOffset];
        if (!hasText(sourceRow) || normalize(sourceRow[0]).includes("调拨记录")) break;
        const row = enrichRow(mapRow(sourceRow, headers, rule, sheet.name, index + rowOffset), context, sheet.name, index + rowOffset);
        result.push({ ...row, externalCode, storeName: row.storeName || context.storeName });
      }
    }
    return result.filter((row) => row.skuCode || row.skuName || Number(row.quantity));
  });
};

const parseTextBlocks = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const separator = rule.textBlock?.blockSeparator ? new RegExp(rule.textBlock.blockSeparator, "g") : /\n-{3,}\n/g;
  return file.text
    .split(separator)
    .map((block, index) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const text = lines.join("\n");
      const phone = text.match(/1[3-9]\d{9}/)?.[0] ?? "";
      const qty = text.match(/数量[:：|\s]*(\d+)/)?.[1] ?? text.match(/\|\s*(\d+)\s*$/m)?.[1] ?? "";
      const skuLine = lines.find((line) => /\|/.test(line)) ?? "";
      const parts = skuLine.split("|").map((part) => part.replace(/^\d+[.、]\s*/, "").trim());
      return applyStaticValues(
        {
          id: makeId(),
          externalCode: text.match(/(?:单号|外部编码|配送单号)[:：\s]*([A-Za-z0-9-]+)/)?.[1] ?? `TEXT-${index + 1}`,
          storeName: text.match(/(?:门店|收货门店)[:：\s]*(.+)/)?.[1]?.split("\n")[0] ?? "",
          receiverName: text.match(/(?:收件人|联系人)[:：\s]*([^\n，,]+)/)?.[1] ?? "",
          receiverPhone: phone,
          receiverAddress: text.match(/(?:地址|收货地址)[:：\s]*(.+)/)?.[1]?.split("\n")[0] ?? "",
          skuCode: parts[0] ?? "",
          skuName: parts[1] ?? "",
          skuSpec: parts[2] ?? "",
          quantity: qty,
          temperature: "",
          remark: "",
          sourceSheet: "text",
          sourceRow: index + 1
        },
        rule
      );
    })
    .filter((row) => row.skuName || row.skuCode || row.storeName || row.receiverName);
};

export const parseWithRule = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  if (rule.sourceKind === "matrix") return parseMatrix(file, rule);
  if (rule.sourceKind === "cards") return parseCards(file, rule);
  if (rule.sourceKind === "textBlocks") return parseTextBlocks(file, rule);
  return parseTable(file, rule);
};

export const validateRows = (rows: OrderRow[], existingCodes: string[] = []): ValidationError[] => {
  const errors: ValidationError[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const add = (field: ValidationError["field"], message: string) => errors.push({ rowId: row.id, rowNumber, field, message });
    if (!row.externalCode) add("externalCode", "外部编码不能为空");
    if (!row.storeName && !(row.receiverName && row.receiverPhone && row.receiverAddress)) {
      add("row", "收货门店，或收件人姓名/电话/地址必须至少填写一组");
    }
    if (!row.skuCode) add("skuCode", "SKU物品编码不能为空");
    if (!row.skuName) add("skuName", "SKU物品名称不能为空");
    if (!Number(row.quantity) || Number(row.quantity) <= 0) add("quantity", "SKU发货数量必须为正数");
    if (row.receiverPhone && !/^1[3-9]\d{9}$|^\d{3,4}-?\d{7,8}$/.test(row.receiverPhone)) add("receiverPhone", "电话格式不正确");
    if (row.temperature && !["冷冻", "冷藏", "常温", "全部", "冷冻,常温", "冷冻,常温,冷藏"].includes(row.temperature)) add("temperature", "温区值不在允许范围内");
  });

  return errors;
};

export const makeHeuristicRule = (file: ExtractedFile): ParseRule => {
  const sheet = file.sheets[0];
  const rows = sheet?.rows ?? [];
  const isCardLike = rows.some((row) => normalize(row[0]).includes("调拨记录"));
  const headerRow = findHeaderRow(rows);
  const headers = rows[headerRow - 1] ?? [];
  const pick = (keywords: readonly string[]) => {
    const normalizedHeaders = headers.map((header) => normalize(header));
    for (const keyword of keywords) {
      const exact = normalizedHeaders.find((header) => header.replace(/\*$/, "") === keyword);
      if (exact) return exact;
    }
    for (const keyword of keywords) {
      const included = normalizedHeaders.find((header) => header.includes(keyword));
      if (included) return included;
    }
    return "";
  };
  const matrixValueStart = headers.findIndex((header, index) => index > 2 && ![
    "仓库名称",
    "货主名称",
    "SKU名称",
    "SKU条码",
    "外部商品编码",
    "库存状态",
    "库存单位",
    "规格",
    "在库数量的总和",
    "可用数量的总和",
    "待移入数的总和",
    "分配数量的总和",
    "冻结数量的总和"
  ].includes(normalize(header)));
  const isMatrixLike = headers.some((header) => normalize(header).includes("SKU名称"))
    && headers.some((header) => normalize(header).includes("SKU条码") || normalize(header).includes("外部商品编码"))
    && matrixValueStart > 0
    && !headers.some((header) => /发货数量|出库数量|订货数量|数量$/.test(normalize(header)));
  const mappings = [
    ["externalCode", ["外部编码", "配送单号", "单号", "订单号"]],
    ["storeName", ["门店", "店铺", "机构"]],
    ["receiverName", ["收货人", "收件人姓名", "收件人", "联系人", "姓名"]],
    ["receiverPhone", ["收货电话", "收件人电话", "电话", "手机", "联系方式"]],
    ["receiverAddress", ["地址"]],
    ["skuCode", ["SKU物品编码", "SKU条码", "外部商品编码", "物品编码", "物料编码", "商品编码", "编码"]],
    ["skuName", ["SKU物品名称", "SKU名称", "物品名称", "商品名称", "品名"]],
    ["quantity", ["SKU发货数量", "发货数量", "出库数量", "订货数量", "数量", "件数"]],
    ["skuSpec", ["规格", "型号"]],
    ["temperature", ["温区"]],
    ["remark", ["备注"]]
  ] as const;

  return {
    id: makeId(),
    name: `${file.fileName.replace(/\.[^.]+$/, "")} 推荐规则`,
    description: "由文件结构启发式生成，可继续通过大模型优化后人工确认。",
    sourceKind: isCardLike ? "cards" : isMatrixLike ? "matrix" : file.fileType === "word" || file.fileType === "pdf" ? "textBlocks" : "table",
    sheetMode: "all",
    headerRow,
    dataStartRow: headerRow + 1,
    groupBy: "externalCode",
    matrix: isMatrixLike ? {
      fixedFields: headers.slice(0, matrixValueStart).map((header) => normalize(header)).filter(Boolean),
      valueColumnsStartAt: matrixValueStart,
      columnHeaderAs: "storeName"
    } : undefined,
    mappings: (isMatrixLike ? [
      { target: "skuCode" as const, source: pick(["SKU条码", "外部商品编码"]) || "SKU条码", guessed: true, confidence: 0.72 },
      { target: "skuName" as const, source: pick(["SKU名称"]) || "SKU名称", guessed: true, confidence: 0.72 },
      { target: "skuSpec" as const, source: pick(["规格"]) || "规格", guessed: true, confidence: 0.72 }
    ] : mappings
      .map(([target, keys]) => {
        const source = pick(keys);
        return { target, source, guessed: true, confidence: source ? 0.72 : 0.35 };
      })
      .filter((mapping) => mapping.source)
      .map((mapping) => mapping.target === "quantity" ? { ...mapping, transform: "number" as const } : mapping)),
    skipPatterns: ["合计", "总计"],
    createdBy: "ai",
    updatedAt: new Date().toISOString()
  };
};

export const normalizeParseRule = (input: Partial<ParseRule>, file?: ExtractedFile): ParseRule => {
  const fallback = file ? makeHeuristicRule(file) : {
    id: makeId(),
    name: "新建表格规则",
    description: "手动配置字段映射后保存。",
    sourceKind: "table",
    sheetMode: "all",
    headerRow: 1,
    dataStartRow: 2,
    groupBy: "externalCode",
    mappings: [],
    skipPatterns: ["合计", "总计"],
    createdBy: "manual",
    updatedAt: new Date().toISOString()
  } satisfies ParseRule;

  const rawMappings = Array.isArray(input.mappings)
    ? input.mappings
      .filter((mapping) => canonicalFields.has(mapping?.target as CanonicalField) && typeof mapping?.source === "string" && mapping.source.trim())
      .map((mapping) => ({
        target: mapping.target as CanonicalField,
        source: mapping.source.trim(),
        confidence: typeof mapping.confidence === "number" ? mapping.confidence : undefined,
        transform: ["number", "phone", "trim", "splitLines"].includes(String(mapping.transform)) ? mapping.transform : undefined,
        guessed: Boolean(mapping.guessed)
      }))
    : [];
  const headers = file?.sheets[0]?.rows[Math.max((fallback.headerRow ?? 1) - 1, 0)]?.map((header) => normalize(header)) ?? [];
  const fallbackByTarget = new Map(fallback.mappings.map((mapping) => [mapping.target, mapping]));
  const fallbackTargetBySource = new Map(fallback.mappings.map((mapping) => [normalize(mapping.source), mapping.target]));
  const usedSources = new Set<string>();
  const mappings = rawMappings.map((mapping) => {
    const source = normalize(mapping.source);
    const headerExists = !headers.length || headers.includes(source);
    const fallbackTarget = fallbackTargetBySource.get(source);
    const duplicateSource = usedSources.has(source);
    const mismatchedKnownHeader = Boolean(fallbackTarget && fallbackTarget !== mapping.target);
    const replacement = fallbackByTarget.get(mapping.target);
    const selected = (!headerExists || duplicateSource || mismatchedKnownHeader) && replacement ? replacement : mapping;
    usedSources.add(normalize(selected.source));
    return selected;
  });
  for (const fallbackMapping of fallback.mappings) {
    if (!mappings.some((mapping) => mapping.target === fallbackMapping.target)) {
      mappings.push(fallbackMapping);
    }
  }

  const headerRow = asPositiveRow(input.headerRow, fallback.headerRow ?? 1);
  const dataStartRow = Math.max(asPositiveRow(input.dataStartRow, fallback.dataStartRow ?? headerRow + 1), headerRow + 1);
  const sourceKind = (sourceKinds.has(String(input.sourceKind)) ? input.sourceKind : fallback.sourceKind) as ParseRule["sourceKind"];
  const sheetMode = (sheetModes.has(String(input.sheetMode)) ? input.sheetMode : fallback.sheetMode) as ParseRule["sheetMode"];
  const groupBy = (canonicalFields.has(input.groupBy as CanonicalField) ? input.groupBy : fallback.groupBy) as CanonicalField;

  const candidate: ParseRule = {
    ...fallback,
    ...input,
    id: input.id || fallback.id,
    name: input.name || fallback.name,
    description: input.description || fallback.description,
    sourceKind,
    sheetMode,
    headerRow,
    dataStartRow,
    groupBy,
    mappings: mappings.length ? mappings : fallback.mappings,
    skipPatterns: Array.isArray(input.skipPatterns) ? input.skipPatterns.filter((item): item is string => typeof item === "string") : fallback.skipPatterns,
    createdBy: input.createdBy === "manual" || input.createdBy === "system" || input.createdBy === "ai" ? input.createdBy : fallback.createdBy,
    updatedAt: input.updatedAt || new Date().toISOString()
  };

  if (file && fallback.mappings.length) {
    const candidateRows = parseWithRule(file, candidate);
    const fallbackRows = parseWithRule(file, fallback);
    if ((!rawMappings.length || candidateRows.length === 0) && fallbackRows.length > 0) {
      return {
        ...candidate,
        sourceKind: fallback.sourceKind,
        sheetMode: fallback.sheetMode,
        headerRow: fallback.headerRow,
        dataStartRow: fallback.dataStartRow,
        matrix: fallback.matrix,
        textBlock: fallback.textBlock,
        mappings: fallback.mappings
      };
    }
  }

  return candidate;
};

export const buildRulePrompt = (file: ExtractedFile) => {
  const sheetPreview = file.sheets.slice(0, 3).map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.slice(0, 12)
  }));
  return `你是物流出库单解析规则设计助手。请根据文件预览生成通用解析规则 JSON，不要直接输出订单数据。
目标字段：${Object.values(fieldLabels).join("、")}。
规则需描述 headerRow、dataStartRow、sheetMode、sourceKind、groupBy、mappings、skipPatterns；复杂结构可用 matrix/textBlock。
文件名：${file.fileName}
文件类型：${file.fileType}
表格预览：${JSON.stringify(sheetPreview)}
文本预览：${file.text.slice(0, 4000)}
只返回 JSON。`;
};
