import { ExtractedFile, fieldLabels, OrderRow, ParseRule, RawCell, ValidationError } from "./types";

const normalize = (value: RawCell) => String(value ?? "").replace(/\s+/g, " ").trim();

const asNumber = (value: RawCell) => {
  const match = String(value ?? "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : "";
};

const hasText = (row: RawCell[]) => row.some((cell) => normalize(cell));

const stockMetricPattern = /总和|库存|可用|待移入|分配|冻结|结余|状态|单位|仓库|货主/;
const itemHeaderPattern = /物品编码|SKU物品编码|商品编码|物品名称|SKU物品名称|商品名称|发货数量|出库数量|数量/;

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

const makeExternalCode = () => `AI-${makeId().replace(/-/g, "").slice(0, 10).toUpperCase()}`;

const collectSourceValues = (sourceRow: RawCell[], headers: RawCell[], fields: string[] = []) => {
  const output: Record<string, string | number> = {};
  fields.forEach((field) => {
    const idx = headers.findIndex((header) => normalize(header) === field);
    if (idx < 0) return;
    const value = sourceRow[idx];
    const normalized = normalize(value);
    if (!normalized) return;
    output[field] = typeof value === "number" ? value : normalized;
  });
  return output;
};

const applyStaticValues = (row: OrderRow, rule: ParseRule) => ({ ...row, ...(rule.staticValues ?? {}) });

const findHeaderRowIndex = (rows: RawCell[][]) => {
  const scored = rows.map((row, index) => {
    const cells = row.map((cell) => normalize(cell));
    const score = [
      cells.some((cell) => /物品编码|SKU物品编码|商品编码|SKU条码|外部商品编码/.test(cell)),
      cells.some((cell) => /物品名称|SKU物品名称|商品名称|SKU名称/.test(cell)),
      cells.some((cell) => /发货数量|出库数量|订货数量|数量/.test(cell))
    ].filter(Boolean).length;
    return { index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index)[0];
  return scored && scored.score >= 2 ? scored.index : Math.max(rows.findIndex((row) => row.filter((cell) => normalize(cell)).length >= 3), 0);
};

const valueAfterLabel = (rows: RawCell[][], labels: string[]) => {
  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = normalize(row[index]);
      if (!labels.some((label) => cell === label || cell.replace(/[:：]$/, "") === label)) continue;
      const inline = cell.match(/[:：]\s*(.+)$/)?.[1];
      if (inline) return inline.trim();
      for (let next = index + 1; next < row.length; next += 1) {
        const value = normalize(row[next]);
        if (value) return value;
      }
    }
  }
  return "";
};

const defaultMetaLabels: NonNullable<ParseRule["metadata"]>["labels"] = {
  externalCode: ["单据号", "单据编号", "配送单号", "外部编码", "订单号"],
  storeName: ["收货机构", "收货门店", "门店", "订货机构"],
  receiverName: ["收货人", "收件人", "联系人"],
  receiverPhone: ["收货电话", "收件人电话", "联系电话", "电话", "手机"],
  receiverAddress: ["收货地址", "收件人地址", "地址"]
};

const inferSheetStoreName = (sheetName: string, rows: RawCell[][], metadata?: ParseRule["metadata"]) => {
  const title = normalize(rows[0]?.[0]);
  const labels = metadata?.labels?.storeName ?? defaultMetaLabels.storeName ?? [];
  const explicit = valueAfterLabel(rows, labels);
  if (!metadata?.preferTitleStore && explicit) return explicit;
  const pattern = metadata?.titleStorePattern ?? "^(.+?)(?:出库单|配送发货单|配送单)";
  const titleStore = title.match(new RegExp(pattern))?.[1]?.trim();
  if (titleStore && (metadata?.preferTitleStore || !explicit)) return titleStore;
  if (explicit) return explicit;
  return sheetName;
};

const inferSheetExternalCode = (sheetName: string, rows: RawCell[][], metadata?: ParseRule["metadata"]) => {
  const labels = metadata?.labels?.externalCode ?? defaultMetaLabels.externalCode ?? [];
  const explicit = valueAfterLabel(rows, labels);
  if (explicit) return explicit;
  const title = normalize(rows[0]?.[0]);
  const pattern = metadata?.titleExternalCodePattern ?? "(PS\\d+)";
  const titleCode = title.match(new RegExp(pattern, "i"))?.[1];
  if (titleCode) return titleCode;
  return metadata?.sheetNameAsExternalCode ? `SHEET-${sheetName}` : "";
};

const inferSheetMeta = (sheetName: string, rows: RawCell[][], metadata?: ParseRule["metadata"]) => ({
  externalCode: inferSheetExternalCode(sheetName, rows, metadata),
  storeName: inferSheetStoreName(sheetName, rows, metadata),
  receiverName: valueAfterLabel(rows, metadata?.labels?.receiverName ?? defaultMetaLabels.receiverName ?? []),
  receiverPhone: valueAfterLabel(rows, metadata?.labels?.receiverPhone ?? defaultMetaLabels.receiverPhone ?? []),
  receiverAddress: valueAfterLabel(rows, metadata?.labels?.receiverAddress ?? defaultMetaLabels.receiverAddress ?? [])
});

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
    const meta = inferSheetMeta(sheet.name, sheet.rows, rule.metadata);
    const rows = sheet.rows.slice(startIndex).filter(hasText);
    return rows
      .filter((row) => !rule.skipPatterns?.some((pattern) => normalize(row.join(" ")).includes(pattern)))
      .map((row, offset) => {
        const mapped = mapRow(row, headers, rule, sheet.name, startIndex + offset);
        return {
          ...mapped,
          externalCode: mapped.externalCode || meta.externalCode,
          storeName: mapped.storeName || meta.storeName,
          receiverName: mapped.receiverName || meta.receiverName,
          receiverPhone: mapped.receiverPhone || meta.receiverPhone,
          receiverAddress: mapped.receiverAddress || meta.receiverAddress
        };
      })
      .filter((row) => row.skuCode && row.skuName && Number(row.quantity) > 0);
  });
};

const parseMatrix = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const sheet = file.sheets[0];
  if (!sheet) return [];
  const headerIndex = Math.max((rule.headerRow ?? 1) - 1, 0);
  const headers = sheet.rows[headerIndex] ?? [];
  const inferredStart = headers.findIndex((header, index) => {
    const text = normalize(header);
    if (!text || stockMetricPattern.test(text)) return false;
    return index > 0 && headers.slice(0, index).some((candidate) => /待移入|冻结|分配|可用|在库/.test(normalize(candidate)));
  });
  const configuredValueStart = rule.matrix?.valueColumnsStartAt ? Math.max(rule.matrix.valueColumnsStartAt - 1, 0) : undefined;
  const valueStart = configuredValueStart ?? (inferredStart >= 0 ? inferredStart : 2);
  const explicitEnd = headers.findIndex((header) => normalize(header).includes("下单后结余"));
  const valueEnd = explicitEnd > valueStart ? explicitEnd : headers.length;
  const baseHeaders = headers.slice(0, valueStart);
  const rows: OrderRow[] = [];
  const headerIndexOf = (labels: string[]) => headers.findIndex((header) => labels.some((label) => normalize(header) === label));
  const skuNameCol = headerIndexOf(["SKU名称", "物品名称", "商品名称"]);
  const skuCodeCol = headerIndexOf(["SKU条码", "外部商品编码", "SKU物品编码", "商品编码"]);
  const skuSpecCol = headerIndexOf(["规格", "SKU规格型号", "规格型号"]);
  const groupByIndexes = rule.matrix?.groupByFields?.map((field) => headers.findIndex((header) => normalize(header) === field)).filter((index) => index >= 0) ?? [];
  const groupCodes = new Map<string, string>();
  const preserveFields = rule.matrix?.preserveFields ?? headers.slice(0, valueStart).map((header) => normalize(header)).filter(Boolean);
  const allSourceFields = headers.map((header) => normalize(header)).filter(Boolean);

  sheet.rows.slice(headerIndex + 1).forEach((sourceRow, offset) => {
    if (!hasText(sourceRow)) return;
    const groupValues = groupByIndexes.map((index) => normalize(sourceRow[index])).filter(Boolean);
    const matrixGroupKey = groupValues.join("-");
    const matrixReceiverName = groupValues[groupValues.length - 1] || matrixGroupKey;
    const externalCode = (() => {
      if (rule.matrix?.externalCodeStrategy === "randomPerGroup") {
        const key = matrixGroupKey || `${sheet.name}-${offset + 1}`;
        const existing = groupCodes.get(key);
        if (existing) return existing;
        const created = makeExternalCode();
        groupCodes.set(key, created);
        return created;
      }
      return "";
    })();
    const preserved = collectSourceValues(sourceRow, headers, allSourceFields);
    headers.slice(valueStart, valueEnd).forEach((header, headerOffset) => {
      const columnName = normalize(header);
      if (!columnName || stockMetricPattern.test(columnName)) return;
      const value = sourceRow[valueStart + headerOffset];
      if (!normalize(value)) return;
      const base = mapRow(sourceRow.slice(0, valueStart), baseHeaders, rule, sheet.name, headerIndex + 1 + offset);
      const quantity = asNumber(value);
      if (!quantity || quantity <= 0) return;
      rows.push({
        ...base,
        id: makeId(),
        externalCode: base.externalCode || externalCode || matrixGroupKey,
        storeName: base.storeName || matrixReceiverName || (rule.matrix?.columnHeaderAs === "storeName" ? columnName : ""),
        remark: [base.remark, columnName].filter(Boolean).join(" "),
        skuCode: skuCodeCol >= 0 ? normalize(sourceRow[skuCodeCol]) : base.skuCode,
        skuName: skuNameCol >= 0 ? normalize(sourceRow[skuNameCol]) : base.skuName,
        skuSpec: skuSpecCol >= 0 ? normalize(sourceRow[skuSpecCol]) : base.skuSpec,
        quantity: quantity || normalize(value),
        sourceValues: {
          ...preserved,
          "门店列": columnName,
          "门店数量": quantity || normalize(value)
        }
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
    return text && !stockMetricPattern.test(text);
  });
  return hasSku && hasStoreColumns;
};

const parseTextBlocks = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const deliveryRows = parseDeliveryText(file, rule);
  if (deliveryRows.length) return deliveryRows;

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

const splitSkuNameAndSpec = (value: string) => {
  const text = value.replace(/\s+/g, " ").trim();
  const match = text.match(/^(.+?)\s+((?:\d|[A-Z]+码|均码|L码|XL码|2XL码|3XL码|4XL码).*)$/i);
  if (!match) return { skuName: text, skuSpec: "" };
  return { skuName: match[1].trim(), skuSpec: match[2].trim() };
};

const parseDeliveryText = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const text = file.text.replace(/\s+/g, " ").trim();
  if (!text || !/(单据编号|配送单|物品编码|发货数量)/.test(text)) return [];

  const externalCode = text.match(/单据编号[:：]\s*([A-Za-z0-9-]+)/)?.[1] ?? "";
  const storeName = text.match(/收货机构[:：]\s*(.+?)\s+(?:订货机构|供货机构|送货机构|业务模式)[:：]/)?.[1]?.trim() ?? "";
  const receiverName = text.match(/收货人[:：]\s*(.+?)\s+收货电话[:：]/)?.[1]?.trim() ?? "";
  const receiverPhone = text.match(/收货电话[:：]\s*([0-9\-]+)/)?.[1] ?? "";
  const receiverAddress = text.match(/收货地址[:：]\s*(.+?)\s+(?:打印次数|备注|物品类别|第\d+页|$)/)?.[1]?.trim() ?? "";
  const output: OrderRow[] = [];
  const itemPattern = /(?:^|\s)(\d{1,4})\s+([\u4e00-\u9fa5A-Za-z0-9（）()]+)\s+([A-Za-z0-9-]{3,})\s+(.+?)\s+(件|瓶|包|桶|盒|袋|个|箱|套)\s+(\d+(?:\.\d+)?)(?=\s+\d{1,4}\s+[\u4e00-\u9fa5A-Za-z0-9（）()]+\s+[A-Za-z0-9-]{3,}|\s+合\s*计|\s+物品类别|\s+第\d+页|$)/g;

  for (const match of text.matchAll(itemPattern)) {
    const [, rowNo, category, skuCode, nameAndSpec, unit, quantity] = match;
    if (!skuCode || !nameAndSpec || !quantity) continue;
    const { skuName, skuSpec } = splitSkuNameAndSpec(nameAndSpec);
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
      skuSpec,
      temperature: "",
      remark: [category, unit].filter(Boolean).join(" / "),
      sourceSheet: file.fileType,
      sourceRow: Number(rowNo) || output.length + 1
    }, rule));
  }

  return output;
};

const looksLikeCardSheet = (file: ExtractedFile) =>
  file.sheets.some((sheet) => sheet.rows.some((row) => normalize(row[0]).includes("调拨记录") || normalize(row[0]).includes("记录 #")));

const defaultCardRule = {
  startMarkers: ["调拨记录", "记录 #"],
  infoLabels: {
    storeName: "调入门店",
    receiverName: "收货人",
    receiverPhone: "电话",
    receiverAddress: "收货地址"
  },
  itemHeaderLabels: {
    skuCode: "物品编码",
    skuName: "物品名称",
    skuSpec: "规格",
    quantity: "数量"
  }
} satisfies NonNullable<ParseRule["card"]>;

const parseCardSheets = (file: ExtractedFile, rule: ParseRule): OrderRow[] => {
  const targetSheets = rule.sheetMode === "first" ? file.sheets.slice(0, 1) : file.sheets;
  const cardRule = rule.card ?? defaultCardRule;
  const output: OrderRow[] = [];

  targetSheets.forEach((sheet) => {
    const rows = sheet.rows;
    for (let index = 0; index < rows.length; index += 1) {
      const marker = normalize(rows[index]?.[0]);
      if (!cardRule.startMarkers.some((startMarker) => marker.includes(startMarker))) continue;

      const cardStart = index;
      let cardEnd = rows.length;
      for (let next = index + 1; next < rows.length; next += 1) {
        const nextMarker = normalize(rows[next]?.[0]);
        if (cardRule.startMarkers.some((startMarker) => nextMarker.includes(startMarker))) {
          cardEnd = next;
          break;
        }
      }

      const cardRows = rows.slice(cardStart, cardEnd);
      const infoLabels = Object.values(cardRule.infoLabels).filter(Boolean);
      const itemLabels = Object.values(cardRule.itemHeaderLabels).filter(Boolean);
      const infoRows = cardRows.filter((row) => row.some((cell) => infoLabels.includes(normalize(cell))));
      const headerOffset = cardRows.findIndex((row) => itemLabels.every((label) => row.some((cell) => normalize(cell) === label)));
      if (headerOffset < 0) continue;

      const valueAfter = (label = "") => {
        const row = infoRows.find((candidate) => candidate.some((cell) => normalize(cell) === label)) ?? [];
        const labelIndex = row.findIndex((cell) => normalize(cell) === label);
        return labelIndex >= 0 ? normalize(row[labelIndex + 1]) : "";
      };
      const storeName = valueAfter(cardRule.infoLabels.storeName);
      const receiverName = valueAfter(cardRule.infoLabels.receiverName);
      const receiverPhone = valueAfter(cardRule.infoLabels.receiverPhone);
      const receiverAddress = valueAfter(cardRule.infoLabels.receiverAddress);
      const externalCode = marker.match(/#\s*([A-Za-z0-9-]+)/)?.[1] ? `CARD-${marker.match(/#\s*([A-Za-z0-9-]+)/)?.[1]}` : "";
      const headers = cardRows[headerOffset];
      const col = (label = "") => headers.findIndex((cell) => normalize(cell) === label);
      const codeCol = col(cardRule.itemHeaderLabels.skuCode);
      const nameCol = col(cardRule.itemHeaderLabels.skuName);
      const specCol = col(cardRule.itemHeaderLabels.skuSpec);
      const qtyCol = col(cardRule.itemHeaderLabels.quantity);

      cardRows.slice(headerOffset + 1).forEach((row, offset) => {
        const rowText = normalize(row.join(" "));
        if (!rowText || /合计|总计|小计/.test(rowText)) return;
        const skuCode = normalize(row[codeCol]);
        const skuName = normalize(row[nameCol]);
        const quantity = asNumber(row[qtyCol]);
        if (!skuCode || !skuName || !quantity) return;
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
    if (rule.sourceKind === "cards" || looksLikeCardSheet(file)) return parseCardSheets(file, rule);
    if (rule.sourceKind === "matrix") return parseMatrix(file, rule);
    if (looksLikeMatrixSheet(file)) return parseMatrix(file, {
      ...rule,
      sourceKind: "matrix",
      matrix: rule.matrix ?? {
        fixedFields: ["SKU名称", "SKU条码", "规格"],
        groupByFields: ["仓库名称", "货主名称"],
        preserveFields: (file.sheets[0]?.rows[rule.headerRow ? rule.headerRow - 1 : 0] ?? []).map((header) => normalize(header)).filter(Boolean),
        externalCodeStrategy: "randomPerGroup",
        columnHeaderAs: "storeName"
      }
    });
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
  const headerRowIndex = findHeaderRowIndex(rows);
  let headerRow = headerRowIndex + 1;
  const headers = rows[headerRow - 1] ?? [];
  const pick = (keywords: readonly string[]) => {
    const normalized = headers.map((header) => normalize(header));
    for (const keyword of keywords) {
      const exact = normalized.find((header) => header === keyword);
      if (exact) return exact;
    }
    for (const keyword of keywords) {
      const fuzzy = normalized.find((header) => header.includes(keyword) && !stockMetricPattern.test(header));
      if (fuzzy) return fuzzy;
    }
    return "";
  };
  const hasSkuColumns = Boolean(pick(["SKU名称", "物品名称", "商品名称"])) && Boolean(pick(["SKU条码", "外部商品编码", "物品编码", "商品编码"]));
  const matrixStart = headers.findIndex((header) => normalize(header).includes("待移入数") || normalize(header).includes("冻结数量"));
  const firstStoreColumn = matrixStart >= 0 ? headers.findIndex((header, index) => {
    const text = normalize(header);
    return index > matrixStart && text && !stockMetricPattern.test(text);
  }) : -1;
  const hasStoreMatrix = firstStoreColumn >= 0 && headers.slice(firstStoreColumn).some((header) => {
    const text = normalize(header);
    return text && !stockMetricPattern.test(text);
  });
  const hasCardBlocks = looksLikeCardSheet(file);
  const isTextDocument = file.fileType === "word" || file.fileType === "pdf" || file.fileType === "text";
  const metadata: ParseRule["metadata"] = isTextDocument || hasStoreMatrix ? undefined : {
    labels: {
      externalCode: ["单据号", "单据编号", "配送单号", "外部编码", "订单号"],
      storeName: ["收货机构", "收货门店", "门店", "订货机构"],
      receiverName: ["收货人", "收件人", "联系人"],
      receiverPhone: ["收货电话", "收件人电话", "联系电话", "电话", "手机"],
      receiverAddress: ["收货地址", "收件人地址", "地址"]
    },
    titleStorePattern: "^(.+?)(?:出库单|配送发货单|配送单)",
    titleExternalCodePattern: "(PS\\d+)",
    sheetNameAsExternalCode: file.sheets.length > 1,
    preferTitleStore: file.sheets.length > 1
  };
  const mappings = [
    ["externalCode", ["外部编码", "配送单号", "单据号", "单据编号", "单号", "订单号"]],
    ["storeName", ["收货门店", "收货机构", "门店", "店铺", "机构"]],
    ["receiverName", ["收件人", "联系人", "姓名"]],
    ["receiverPhone", ["电话", "手机", "联系方式"]],
    ["receiverAddress", ["地址"]],
    ["skuCode", ["SKU物品编码", "物品编码", "SKU条码", "外部商品编码", "物料编码", "商品编码"]],
    ["skuName", ["SKU物品名称", "物品名称", "SKU名称", "商品名称", "品名"]],
    ["quantity", ["SKU发货数量", "发货数量", "出库数量", "订货数量", "数量", "件数"]],
    ["skuSpec", ["SKU规格型号", "规格型号", "规格", "型号"]],
    ["temperature", ["温区"]],
    ["remark", ["备注"]]
  ] as const;

  return {
    id: makeId(),
    name: `${file.fileName.replace(/\.[^.]+$/, "")} 推荐规则`,
    description: hasCardBlocks ? "识别“调拨记录 #N”卡片边界，逐个卡片提取收货信息和物品小表。" : "由文件结构启发式生成，可继续通过大模型优化后人工确认。",
    sourceKind: hasCardBlocks ? "cards" : hasSkuColumns && hasStoreMatrix ? "matrix" : file.fileType === "word" || file.fileType === "pdf" ? "textBlocks" : "table",
    sheetMode: "all",
    headerRow,
    dataStartRow: headerRow + 1,
    groupBy: "externalCode",
    metadata,
    mappings: isTextDocument || hasCardBlocks ? [] : mappings
      .map(([target, keys]) => {
        const source = pick(keys);
        return { target, source, guessed: true, confidence: source ? 0.72 : 0.35 };
      })
      .filter((mapping) => mapping.source)
      .filter((mapping) => !hasStoreMatrix || ["skuCode", "skuName", "skuSpec"].includes(mapping.target))
      .map((mapping) => mapping.target === "quantity" ? { ...mapping, transform: "number" as const } : mapping),
    matrix: hasSkuColumns && hasStoreMatrix ? {
      fixedFields: ["SKU名称", "SKU条码", "规格"],
      groupByFields: ["仓库名称", "货主名称"],
      preserveFields: headers.map((header) => normalize(header)).filter(Boolean),
      externalCodeStrategy: "randomPerGroup",
      valueColumnsStartAt: firstStoreColumn + 1,
      columnHeaderAs: "storeName"
    } : undefined,
    card: hasCardBlocks ? defaultCardRule : undefined,
    textBlock: isTextDocument ? {
      itemLinePattern: "delivery-note"
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
  "metadata": {
    "labels": {
      "externalCode": ["单据号","单据编号","配送单号"],
      "storeName": ["收货机构","收货门店","订货机构"],
      "receiverName": ["收货人","联系人"],
      "receiverPhone": ["收货电话","联系电话"],
      "receiverAddress": ["收货地址"]
    },
    "titleStorePattern": "^(.+?)(?:出库单|配送发货单|配送单)",
    "titleExternalCodePattern": "(PS\\\\d+)",
    "sheetNameAsExternalCode": true,
    "preferTitleStore": true
  },
  "mappings": [
    { "target": "skuName", "source": "SKU名称", "confidence": 0.9, "guessed": true }
  ],
  "matrix": { "fixedFields": ["SKU名称","SKU条码","规格"], "groupByFields": ["仓库名称","货主名称"], "preserveFields": ["仓库名称","货主名称","SKU名称","SKU条码","外部商品编码","库存状态","库存单位","规格","在库数量的总和","可用数量的总和","待移入数的总和","分配数量的总和","冻结数量的总和","银泰","金银潭","金桥","门店B","门店D","下单后结余"], "externalCodeStrategy": "randomPerGroup", "valueColumnsStartAt": 14, "columnHeaderAs": "storeName" },
  "card": {
    "startMarkers": ["调拨记录", "记录 #"],
    "infoLabels": { "storeName": "调入门店", "receiverName": "收货人", "receiverPhone": "电话", "receiverAddress": "收货地址" },
    "itemHeaderLabels": { "skuCode": "物品编码", "skuName": "物品名称", "skuSpec": "规格", "quantity": "数量" }
  },
  "skipPatterns": ["合计", "总计"]
}
target 只能取这些英文内部字段：externalCode, storeName, receiverName, receiverPhone, receiverAddress, skuCode, skuName, quantity, skuSpec, temperature, remark。
source 必须是文件表头原文，例如 SKU名称、SKU条码、物品编码、数量。
sourceKind 只能是 table、matrix、cards、textBlocks；sheetMode 只能是 first、all。
如果收货门店、收件人、电话、地址、单据号不在明细表头行内，而是在标题、页眉、页脚或独立键值区域中，必须用 metadata.labels 和 title*Pattern 描述提取方式，不要把这些字段硬塞进 mappings。
如果存在 SKU 行 + 门店列的横向矩阵，sourceKind 必须为 matrix，门店列从 1-based 列号 valueColumnsStartAt 开始；同一笔单的聚合字段写入 matrix.groupByFields，例如 ["仓库名称","货主名称"]；外部编码使用 matrix.externalCodeStrategy="randomPerGroup" 随机生成，同一 groupByFields 组合共用一个编码；需要在预览列表展示的原始列写入 matrix.preserveFields。
如果每条记录由“调拨记录 #N”这类标题行、收货信息行和物品小表组成，sourceKind 必须为 cards，并用 card 描述卡片边界、收货信息标签和物品小表表头；此时 mappings 可以为空。
目标字段中文含义：${Object.values(fieldLabels).join("、")}。
文件名：${file.fileName}
文件类型：${file.fileType}
表格预览：${JSON.stringify(sheetPreview)}
文本预览：${file.text.slice(0, 4000)}
只返回 JSON。`;
};
