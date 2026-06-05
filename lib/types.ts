export type CanonicalField =
  | "externalCode"
  | "storeName"
  | "receiverName"
  | "receiverPhone"
  | "receiverAddress"
  | "skuCode"
  | "skuName"
  | "quantity"
  | "skuSpec"
  | "temperature"
  | "remark";

export type SourceKind = "table" | "matrix" | "cards" | "textBlocks";

export type FieldMapping = {
  target: CanonicalField;
  source: string;
  confidence?: number;
  transform?: "number" | "phone" | "trim" | "splitLines";
  guessed?: boolean;
};

export type ParseRule = {
  id: string;
  name: string;
  description: string;
  sourceKind: SourceKind;
  sheetMode: "first" | "all";
  headerRow?: number;
  dataStartRow?: number;
  dataEndHint?: string;
  groupBy: CanonicalField;
  mappings: FieldMapping[];
  matrix?: {
    fixedFields: string[];
    valueColumnsStartAt?: number;
    columnHeaderAs: "storeName" | "date";
    valuePattern?: string;
  };
  card?: {
    startMarkers: string[];
    infoLabels: Partial<Record<CanonicalField, string>>;
    itemHeaderLabels: Partial<Record<CanonicalField, string>>;
  };
  textBlock?: {
    blockSeparator?: string;
    itemLinePattern?: string;
  };
  staticValues?: Partial<Record<CanonicalField, string>>;
  skipPatterns?: string[];
  createdBy: "ai" | "manual" | "system";
  updatedAt: string;
};

export type RawCell = string | number | boolean | null | undefined;

export type SheetData = {
  name: string;
  rows: RawCell[][];
};

export type ExtractedFile = {
  fileName: string;
  fileType: "excel" | "word" | "pdf" | "text" | "unknown";
  sheets: SheetData[];
  text: string;
};

export type OrderRow = {
  id: string;
  externalCode: string;
  storeName: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  skuCode: string;
  skuName: string;
  quantity: number | string;
  skuSpec: string;
  temperature: string;
  remark: string;
  sourceSheet?: string;
  sourceRow?: number;
};

export type ValidationError = {
  rowId: string;
  rowNumber: number;
  field: CanonicalField | "row";
  message: string;
};

export const fieldLabels: Record<CanonicalField, string> = {
  externalCode: "外部编码",
  storeName: "收货门店",
  receiverName: "收件人姓名",
  receiverPhone: "收件人电话",
  receiverAddress: "收件人地址",
  skuCode: "SKU物品编码",
  skuName: "SKU物品名称",
  quantity: "SKU发货数量",
  skuSpec: "SKU规格型号",
  temperature: "温区",
  remark: "备注"
};

export const emptyOrderRow = (): OrderRow => ({
  id: crypto.randomUUID(),
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
  remark: ""
});
