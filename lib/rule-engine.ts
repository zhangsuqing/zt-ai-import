import { ExtractedFile, fieldLabels, OrderRow, ParseRule, RawCell, ValidationError } from "./types";

const normalize = (value: RawCell) => String(value ?? "").replace(/\s+/g, " ").trim();

const asNumber = (value: RawCell) => {
  const match = String(value ?? "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : "";
};

const hasText = (row: RawCell[]) => row.some((cell) => normalize(cell));

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
    const rows = sheet.rows.slice(startIndex).filter(hasText);
    return rows
      .filter((row) => !rule.skipPatterns?.some((pattern) => normalize(row.join(" ")).includes(pattern)))
      .map((row, offset) => mapRow(row, headers, rule, sheet.name, startIndex + offset));
  });
};

const parseMatrix = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const sheet = file.sheets[0];
  if (!sheet) return [];
  const headerIndex = Math.max((rule.headerRow ?? 1) - 1, 0);
  const headers = sheet.rows[headerIndex] ?? [];
  const inferredStart = headers.findIndex((header) => normalize(header).includes("待移入数") || normalize(header).includes("冻结数量"));
  const valueStart = rule.matrix?.valueColumnsStartAt ?? (inferredStart >= 0 ? inferredStart + 2 : 2);
  const explicitEnd = headers.findIndex((header) => normalize(header).includes("下单后结余"));
  const valueEnd = explicitEnd > valueStart ? explicitEnd : headers.length;
  const baseHeaders = headers.slice(0, valueStart);
  const rows: OrderRow[] = [];
  const headerIndexOf = (labels: string[]) => headers.findIndex((header) => labels.some((label) => normalize(header) === label));
  const skuNameCol = headerIndexOf(["SKU名称", "物品名称", "商品名称"]);
  const skuCodeCol = headerIndexOf(["SKU条码", "外部商品编码", "SKU物品编码", "商品编码"]);
  const skuSpecCol = headerIndexOf(["规格", "SKU规格型号", "规格型号"]);

  sheet.rows.slice(headerIndex + 1).forEach((sourceRow, offset) => {
    if (!hasText(sourceRow)) return;
    headers.slice(valueStart, valueEnd).forEach((header, headerOffset) => {
      const columnName = normalize(header);
      if (!columnName || /总和|库存|可用|分配|冻结|结余/.test(columnName)) return;
      const value = sourceRow[valueStart + headerOffset];
      if (!normalize(value)) return;
      const base = mapRow(sourceRow.slice(0, valueStart), baseHeaders, rule, sheet.name, headerIndex + 1 + offset);
      const quantity = asNumber(value);
      if (!quantity || quantity <= 0) return;
      rows.push({
        ...base,
        id: makeId(),
        externalCode: base.externalCode || `${columnName}-${offset + 1}-${headerOffset + 1}`,
        storeName: rule.matrix?.columnHeaderAs === "storeName" ? columnName : base.storeName,
        remark: rule.matrix?.columnHeaderAs === "date" ? `${base.remark} ${columnName}`.trim() : base.remark,
        skuCode: skuCodeCol >= 0 ? normalize(sourceRow[skuCodeCol]) : base.skuCode,
        skuName: skuNameCol >= 0 ? normalize(sourceRow[skuNameCol]) : base.skuName,
        skuSpec: skuSpecCol >= 0 ? normalize(sourceRow[skuSpecCol]) : base.skuSpec,
        quantity: quantity || normalize(value)
      });
    });
  });
  return rows;
};

const looksLikeMatrixSheet = (file: ExtractedFile) => {
  const headers = file.sheets[0]?.rows[0] ?? [];
  const hasSku = headers.some((header) => ["SKU名称", "SKU条码", "外部商品编码"].includes(normalize(header)));
  const markerIndex = headers.findIndex((header) => normalize(header).includes("待移入数") || normalize(header).includes("冻结数量"));
  const hasStoreColumns = markerIndex >= 0 && headers.slice(markerIndex + 1).some((header) => {
    const text = normalize(header);
    return text && !/总和|库存|可用|冻结|分配|结余/.test(text);
  });
  return hasSku && hasStoreColumns;
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

const looksLikeCardSheet = (file: ExtractedFile) =>
  file.sheets.some((sheet) => sheet.rows.some((row) => normalize(row[0]).includes("调拨记录") || normalize(row[0]).includes("记录 #")));

const parseCardSheets = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const targetSheets = rule.sheetMode === "first" ? file.sheets.slice(0, 1) : file.sheets;
  const output: OrderRow[] = [];

  targetSheets.forEach((sheet) => {
    const rows = sheet.rows;
    for (let index = 0; index < rows.length; index += 1) {
      const marker = normalize(rows[index]?.[0]);
      if (!marker.includes("调拨记录") && !marker.includes("记录 #")) continue;

      const cardStart = index;
      let cardEnd = rows.length;
      for (let next = index + 1; next < rows.length; next += 1) {
        const nextMarker = normalize(rows[next]?.[0]);
        if (nextMarker.includes("调拨记录") || nextMarker.includes("记录 #")) {
          cardEnd = next;
          break;
        }
      }

      const cardRows = rows.slice(cardStart, cardEnd);
      const infoRow = cardRows.find((row) => row.some((cell) => normalize(cell) === "调入门店" || normalize(cell) === "收货人" || normalize(cell) === "电话")) ?? [];
      const addressRow = cardRows.find((row) => row.some((cell) => normalize(cell) === "收货地址")) ?? [];
      const headerOffset = cardRows.findIndex((row) => row.some((cell) => normalize(cell) === "物品编码") && row.some((cell) => normalize(cell) === "数量"));
      if (headerOffset < 0) continue;

      const valueAfter = (row: RawCell[], label: string) => {
        const labelIndex = row.findIndex((cell) => normalize(cell) === label);
        return labelIndex >= 0 ? normalize(row[labelIndex + 1]) : "";
      };
      const storeName = valueAfter(infoRow, "调入门店");
      const receiverName = valueAfter(infoRow, "收货人");
      const receiverPhone = valueAfter(infoRow, "电话");
      const receiverAddress = valueAfter(addressRow, "收货地址");
      const externalCode = marker.match(/#\s*([A-Za-z0-9-]+)/)?.[1] ? `CARD-${marker.match(/#\s*([A-Za-z0-9-]+)/)?.[1]}` : "";
      const headers = cardRows[headerOffset];
      const col = (label: string) => headers.findIndex((cell) => normalize(cell) === label);
      const codeCol = col("物品编码");
      const nameCol = col("物品名称");
      const specCol = col("规格");
      const qtyCol = col("数量");

      cardRows.slice(headerOffset + 1).forEach((row, offset) => {
        const skuCode = normalize(row[codeCol]);
        const skuName = normalize(row[nameCol]);
        const quantity = asNumber(row[qtyCol]);
        if (!skuCode && !skuName && !quantity) return;
        output.push(applyStaticValues({
          id: makeId(),
          externalCode,
          storeName,
          receiverName,
          receiverPhone,
          receiverAddress,
          skuCode,
          skuName,
          quantity,
          skuSpec: normalize(row[specCol]),
          temperature: "",
          remark: marker,
          sourceSheet: sheet.name,
          sourceRow: cardStart + headerOffset + offset + 2
        }, rule));
      });

      index = cardEnd - 1;
    }
  });

  return output;
};

export const parseWithRule = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const rows = (() => {
    if (rule.sourceKind === "matrix") return parseMatrix(file, rule);
    if (looksLikeMatrixSheet(file)) return parseMatrix(file, { ...rule, sourceKind: "matrix", matrix: rule.matrix ?? { fixedFields: ["SKU名称", "SKU条码", "规格"], columnHeaderAs: "storeName" } });
    if (rule.sourceKind === "cards" || looksLikeCardSheet(file)) return parseCardSheets(file, rule);
    if (rule.sourceKind === "textBlocks") return parseTextBlocks(file, rule);
    return parseTable(file, rule);
  })();
  return shareReceivingInfoByExternalCode(rows);
};

export const shareReceivingInfoByExternalCode = (rows: OrderRow[]): OrderRow[] => {
  const groups = new Map<string, Partial<OrderRow>>();
  rows.forEach((row) => {
    if (!row.externalCode) return;
    const current = groups.get(row.externalCode) ?? {};
    groups.set(row.externalCode, {
      storeName: current.storeName || row.storeName,
      receiverName: current.receiverName || row.receiverName,
      receiverPhone: current.receiverPhone || row.receiverPhone,
      receiverAddress: current.receiverAddress || row.receiverAddress
    });
  });

  return rows.map((row) => {
    if (!row.externalCode) return row;
    const shared = groups.get(row.externalCode);
    if (!shared) return row;
    return {
      ...row,
      storeName: row.storeName || shared.storeName || "",
      receiverName: row.receiverName || shared.receiverName || "",
      receiverPhone: row.receiverPhone || shared.receiverPhone || "",
      receiverAddress: row.receiverAddress || shared.receiverAddress || ""
    };
  });
};

export const validateRows = (rows: OrderRow[], existingCodes: string[] = []): ValidationError[] => {
  const errors: ValidationError[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const add = (field: ValidationError["field"], message: string) => errors.push({ rowId: row.id, rowNumber, field, message });
    if (!row.storeName && !(row.receiverName && row.receiverPhone && row.receiverAddress)) {
      add("row", "收货门店，或收件人姓名/电话/地址必须至少填写一组");
    }
    if (!row.skuCode) add("skuCode", "SKU物品编码不能为空");
    if (!row.skuName) add("skuName", "SKU物品名称不能为空");
    if (!Number(row.quantity) || Number(row.quantity) <= 0) add("quantity", "SKU发货数量必须为正数");
    if (row.receiverPhone && !/^1[3-9]\d{9}$|^\d{3,4}-?\d{7,8}$/.test(row.receiverPhone)) add("receiverPhone", "电话格式不正确");
    if (row.temperature && !["冷冻", "冷藏", "常温", "全部", "冷冻,常温", "冷冻,常温,冷藏"].includes(row.temperature)) add("temperature", "温区值不在允许范围内");
    if (row.externalCode && existingCodes.includes(row.externalCode)) add("externalCode", "与已导入运单重复");
  });

  return errors;
};

export const makeHeuristicRule = (file: ExtractedFile): ParseRule => {
  const sheet = file.sheets[0];
  const rows = sheet?.rows ?? [];
  let headerRow = rows.findIndex((row) => row.filter((cell) => normalize(cell)).length >= 3) + 1;
  if (headerRow <= 0) headerRow = 1;
  const headers = rows[headerRow - 1] ?? [];
  const pick = (keywords: readonly string[]) => {
    const normalized = headers.map((header) => normalize(header));
    const exact = normalized.find((header) => keywords.some((kw) => header === kw));
    if (exact) return exact;
    return normalized.find((header) => keywords.some((kw) => header.includes(kw) && !/仓库|货主|库存|可用|冻结|分配|结余/.test(header))) ?? "";
  };
  const hasSkuColumns = Boolean(pick(["SKU名称"])) && Boolean(pick(["SKU条码", "外部商品编码"]));
  const matrixStart = headers.findIndex((header) => normalize(header).includes("待移入数") || normalize(header).includes("冻结数量"));
  const hasStoreMatrix = matrixStart >= 0 && headers.slice(matrixStart + 1).some((header) => {
    const text = normalize(header);
    return text && !/总和|库存|可用|冻结|分配|结余/.test(text);
  });
  const mappings = [
    ["externalCode", ["外部编码", "配送单号", "单号", "订单号"]],
    ["storeName", ["门店", "店铺", "机构"]],
    ["receiverName", ["收件人", "联系人", "姓名"]],
    ["receiverPhone", ["电话", "手机", "联系方式"]],
    ["receiverAddress", ["地址"]],
    ["skuCode", ["SKU物品编码", "SKU条码", "外部商品编码", "物料编码", "商品编码"]],
    ["skuName", ["SKU物品名称", "SKU名称", "物品名称", "商品名称", "品名"]],
    ["quantity", ["数量", "件数", "发货数量"]],
    ["skuSpec", ["规格", "型号"]],
    ["temperature", ["温区"]],
    ["remark", ["备注"]]
  ] as const;

  return {
    id: makeId(),
    name: `${file.fileName.replace(/\.[^.]+$/, "")} 推荐规则`,
    description: "由文件结构启发式生成，可继续通过大模型优化后人工确认。",
    sourceKind: hasSkuColumns && hasStoreMatrix ? "matrix" : file.fileType === "word" || file.fileType === "pdf" ? "textBlocks" : "table",
    sheetMode: "all",
    headerRow,
    dataStartRow: headerRow + 1,
    groupBy: "externalCode",
    mappings: mappings
      .map(([target, keys]) => {
        const source = pick(keys);
        return { target, source, guessed: true, confidence: source ? 0.72 : 0.35 };
      })
      .filter((mapping) => mapping.source)
      .map((mapping) => mapping.target === "quantity" ? { ...mapping, transform: "number" as const } : mapping),
    matrix: hasSkuColumns && hasStoreMatrix ? {
      fixedFields: ["SKU名称", "SKU条码", "规格"],
      valueColumnsStartAt: matrixStart + 2,
      columnHeaderAs: "storeName"
    } : undefined,
    skipPatterns: ["合计", "总计"],
    createdBy: "ai",
    updatedAt: new Date().toISOString()
  };
};

export const buildRulePrompt = (file: ExtractedFile) => {
  const sheetPreview = file.sheets.slice(0, 3).map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.slice(0, 12)
  }));
  return `你是物流出库单解析规则设计助手。请根据文件预览生成通用解析规则 JSON，不要直接输出订单数据。
必须严格返回以下 TypeScript 结构对应的 JSON，不要使用 field/column/format/single/excel/row 等自定义字段或枚举：
{
  "name": "规则名称",
  "description": "规则说明",
  "sourceKind": "table | matrix | cards | textBlocks",
  "sheetMode": "first | all",
  "headerRow": 1,
  "dataStartRow": 2,
  "groupBy": "externalCode",
  "mappings": [
    { "target": "skuName", "source": "SKU名称", "confidence": 0.9, "guessed": true }
  ],
  "matrix": { "fixedFields": ["SKU名称","SKU条码","规格"], "valueColumnsStartAt": 14, "columnHeaderAs": "storeName" },
  "skipPatterns": ["合计", "总计"]
}
target 只能取这些英文内部字段：externalCode, storeName, receiverName, receiverPhone, receiverAddress, skuCode, skuName, quantity, skuSpec, temperature, remark。
source 必须是文件表头原文，例如 SKU名称、SKU条码、物品编码、数量。
sourceKind 只能是 table、matrix、cards、textBlocks；sheetMode 只能是 first、all。
如果存在 SKU 行 + 门店列的横向矩阵，sourceKind 必须为 matrix，门店列从 1-based 列号 valueColumnsStartAt 开始。
目标字段中文含义：${Object.values(fieldLabels).join("、")}。
文件名：${file.fileName}
文件类型：${file.fileType}
表格预览：${JSON.stringify(sheetPreview)}
文本预览：${file.text.slice(0, 4000)}
只返回 JSON。`;
};
