import { OrderRow } from "./types";

export type ImportTaskStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "PARTIAL_SUCCESS" | "FAILED";
export type ImportBatchStatus = "PENDING" | "QUEUED" | "PROCESSING" | "SUCCEEDED" | "FAILED";
export type OutboxStatus = "PENDING" | "SENT" | "FAILED";

export type ImportTask = {
  id: string;
  traceId: string;
  fileName: string;
  ruleId: string;
  status: ImportTaskStatus;
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  totalBatches: number;
  completedBatches: number;
  degraded: boolean;
  warning?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ImportTaskBatch = {
  id: string;
  taskId: string;
  traceId: string;
  unitId: string;
  batchIndex: number;
  startRow: number;
  endRow: number;
  status: ImportBatchStatus;
  retryCount: number;
  lockedAt?: string;
  completedAt?: string;
  errorMessage?: string;
};

export type ImportTaskError = {
  id: string;
  taskId: string;
  traceId: string;
  unitId: string;
  batchIndex: number;
  rowNumber: number;
  fieldName: string;
  rawValue: string;
  errorCode: string;
  errorReason: string;
  ruleId?: string;
  createdAt: string;
};

export type BatchPerformanceLog = {
  id: string;
  taskId: string;
  traceId: string;
  unitId: string;
  batchIndex: number;
  parseDurationMs: number;
  ruleDurationMs: number;
  validateDurationMs: number;
  insertDurationMs: number;
  totalDurationMs: number;
  status: ImportBatchStatus;
  createdAt: string;
};

export type TraceEvent = {
  id: string;
  traceId: string;
  taskId?: string;
  unitId?: string;
  eventName: string;
  eventStatus: "INFO" | "SUCCESS" | "WARN" | "ERROR";
  message: string;
  occurredAt: string;
};

export type OutboxEvent = {
  id: string;
  aggregateId: string;
  eventType: "ImportTaskCreated" | "ImportBatchCreated";
  schemaVersion: number;
  traceId: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retryCount: number;
  nextRetryAt: string;
  createdAt: string;
  sentAt?: string;
};

export type SkuMaster = {
  id: string;
  skuCode: string;
  name: string;
  spec: string;
  unit: string;
  createdAt: string;
};

export type ImportTaskCreateInput = {
  fileName: string;
  ruleId: string;
  rows: OrderRow[];
  batchSize?: number;
};
