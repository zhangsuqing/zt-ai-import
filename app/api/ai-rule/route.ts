import { NextRequest, NextResponse } from "next/server";
import { buildRulePrompt, makeHeuristicRule } from "@/lib/rule-engine";
import { CanonicalField, ExtractedFile, FieldMapping, ParseRule, SourceKind } from "@/lib/types";

export const runtime = "nodejs";

const parseJsonFromModel = (content: string): Partial<ParseRule> | null => {
  const fenced = content.match(/```json\s*([\s\S]*?)```/)?.[1] ?? content;
  const json = fenced.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const sourceKinds: SourceKind[] = ["table", "matrix", "cards", "textBlocks"];
const canonicalFields: CanonicalField[] = [
  "externalCode",
  "storeName",
  "receiverName",
  "receiverPhone",
  "receiverAddress",
  "skuCode",
  "skuName",
  "quantity",
  "skuSpec",
  "temperature",
  "remark"
];

const labelToField: Record<string, CanonicalField> = {
  外部编码: "externalCode",
  收货门店: "storeName",
  收件人姓名: "receiverName",
  收件人电话: "receiverPhone",
  收件人地址: "receiverAddress",
  SKU物品编码: "skuCode",
  SKU物品名称: "skuName",
  SKU发货数量: "quantity",
  SKU规格型号: "skuSpec",
  温区: "temperature",
  备注: "remark"
};

type LooseMapping = Partial<FieldMapping> & {
  field?: string;
  column?: number;
};

const defaultCardRule: NonNullable<ParseRule["card"]> = {
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
};

const normalizeCell = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const stockMetricPattern = /总和|库存|可用|待移入|分配|冻结|结余|状态|单位|仓库|货主/;

const detectsCardSheet = (file: ExtractedFile) =>
  file.sheets.some((sheet) =>
    sheet.rows.some((row) => {
      const firstCell = normalizeCell(row[0]);
      return firstCell.includes("调拨记录") || firstCell.includes("记录 #");
    })
  );

const detectsMatrixSheet = (file: ExtractedFile) => {
  const headers = file.sheets[0]?.rows[0] ?? [];
  const hasSku = headers.some((header) => ["SKU名称", "SKU条码", "外部商品编码"].includes(normalizeCell(header)));
  const markerIndex = headers.findIndex((header) => normalizeCell(header).includes("待移入数") || normalizeCell(header).includes("冻结数量"));
  const hasStoreColumns = markerIndex >= 0 && headers.slice(markerIndex + 1).some((header) => {
    const text = normalizeCell(header);
    return text && !stockMetricPattern.test(text);
  });
  return hasSku && hasStoreColumns;
};

const hasStructuredTableHeader = (headers: string[]) => {
  const hasCode = headers.some((header) => /物品编码|SKU物品编码|商品编码|SKU条码|外部商品编码/.test(header));
  const hasName = headers.some((header) => /物品名称|SKU物品名称|商品名称|SKU名称/.test(header));
  const hasQuantity = headers.some((header) => /发货数量|出库数量|订货数量|数量/.test(header));
  return hasCode && hasName && hasQuantity;
};

const normalizeGeneratedRule = (fallback: ParseRule, generated: Partial<ParseRule> | null, file: ExtractedFile): ParseRule => {
  if (!generated) return fallback;
  const headerRowIndex = Math.max((fallback.headerRow ?? 1) - 1, 0);
  const headers = file.sheets[0]?.rows[headerRowIndex]?.map((cell) => String(cell ?? "").trim()) ?? [];
  const detectedSourceKind: SourceKind = detectsCardSheet(file) ? "cards" : detectsMatrixSheet(file) ? "matrix" : fallback.sourceKind;
  const isCardRule = detectedSourceKind === "cards";
  const isMatrixRule = detectedSourceKind === "matrix";
  const isTextBlockRule = detectedSourceKind === "textBlocks";
  const keepFallbackTableShape = detectedSourceKind === "table" && hasStructuredTableHeader(headers);
  const mappings = Array.isArray(generated.mappings)
    ? generated.mappings
        .map((mapping) => {
          const item = mapping as LooseMapping;
          if (item.source && canonicalFields.includes(item.target as CanonicalField) && headers.includes(item.source)) return item as FieldMapping;
          const target = item.field ? labelToField[item.field] : undefined;
          const source = typeof item.column === "number" ? headers[item.column] : undefined;
          return target && source ? { target, source, guessed: true, confidence: 0.65 } satisfies FieldMapping : null;
        })
        .filter((mapping) => {
          if (!mapping || !isMatrixRule || mapping.target !== "externalCode") return true;
          return !/SKU|商品|条码|物品/.test(mapping.source);
        })
        .filter((mapping): mapping is FieldMapping => Boolean(mapping))
    : [];

  return {
    ...fallback,
    name: typeof generated.name === "string" ? generated.name : fallback.name,
    description: typeof generated.description === "string" ? generated.description : fallback.description,
    sourceKind: detectedSourceKind,
    sheetMode: keepFallbackTableShape ? fallback.sheetMode : generated.sheetMode === "first" || generated.sheetMode === "all" ? generated.sheetMode : fallback.sheetMode,
    headerRow: isCardRule ? undefined : keepFallbackTableShape ? fallback.headerRow : typeof generated.headerRow === "number" && generated.headerRow >= 1 ? generated.headerRow : fallback.headerRow,
    dataStartRow: isCardRule ? undefined : keepFallbackTableShape ? fallback.dataStartRow : typeof generated.dataStartRow === "number" && generated.dataStartRow >= 1 ? generated.dataStartRow : fallback.dataStartRow,
    groupBy: isMatrixRule ? fallback.groupBy : canonicalFields.includes(generated.groupBy as CanonicalField) ? generated.groupBy as CanonicalField : fallback.groupBy,
    mappings: isCardRule || isTextBlockRule ? fallback.mappings : mappings.length ? mappings : fallback.mappings,
    matrix: isMatrixRule ? fallback.matrix : generated.matrix?.columnHeaderAs === "storeName" || generated.matrix?.columnHeaderAs === "date" ? generated.matrix : fallback.matrix,
    card: isCardRule ? fallback.card ?? defaultCardRule : generated.card ?? fallback.card,
    textBlock: generated.textBlock ?? fallback.textBlock,
    skipPatterns: Array.isArray(generated.skipPatterns) ? generated.skipPatterns.filter((item) => typeof item === "string") : fallback.skipPatterns,
    createdBy: "ai",
    updatedAt: new Date().toISOString()
  };
};

export async function POST(request: NextRequest) {
  const file = (await request.json()) as ExtractedFile;
  const fallback = makeHeuristicRule(file);
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";

  if (!apiKey) {
    return NextResponse.json({
      rule: fallback,
      usedModel: "heuristic-fallback",
      note: "已生成推荐规则，可确认后保存。"
    });
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "你只输出可被 JSON.parse 解析的规则对象，不输出解释。"
          },
          {
            role: "user",
            content: buildRulePrompt(file)
          }
        ]
      })
    });

    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? "";
    const generated = parseJsonFromModel(content);

    return NextResponse.json({
      rule: normalizeGeneratedRule(fallback, generated, file),
      usedModel: model
    });
  } catch (error) {
    return NextResponse.json({
      rule: fallback,
      usedModel: "heuristic-fallback",
      note: "已生成推荐规则，可确认后保存。"
    });
  }
}
