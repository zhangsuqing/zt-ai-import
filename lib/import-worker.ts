import { store } from "./storage";
import { fieldLabels, OrderRow, ValidationError } from "./types";
import { validateRows } from "./rule-engine";
import { importStore, importUid, nowIso } from "./import-storage";
import { ImportTaskBatch, ImportTaskError, OutboxEvent } from "./import-types";

const sensitiveFields = new Set(["receiverPhone", "receiverAddress"]);

function maskValue(field: string, value: unknown) {
  const text = String(value ?? "");
  if (!sensitiveFields.has(field)) return text.slice(0, 200);
  if (field === "receiverPhone") return text.replace(/^(\d{3})\d+(\d{2})$/, "$1****$2");
  if (text.length <= 6) return "***";
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

function toImportError(batch: ImportTaskBatch, row: OrderRow, rowNumber: number, error: ValidationError): ImportTaskError {
  const fieldName = error.field === "row" ? "row" : error.field;
  return {
    id: importUid("err"),
    taskId: batch.taskId,
    traceId: batch.traceId,
    unitId: batch.unitId,
    batchIndex: batch.batchIndex,
    rowNumber,
    fieldName,
    rawValue: fieldName === "row" ? "" : maskValue(fieldName, row[fieldName as keyof OrderRow]),
    errorCode: error.field === "row" ? "E_ROW_INVALID" : "E_FIELD_INVALID",
    errorReason: error.message,
    createdAt: nowIso()
  };
}

function validateRequired(rows: Array<{ rowNumber: number; row: OrderRow }>, batch: ImportTaskBatch) {
  const rowErrors = validateRows(rows.map((item) => item.row));
  const byId = new Map(rows.map((item) => [item.row.id, item]));
  return rowErrors.map((error) => {
    const item = byId.get(error.rowId);
    return item ? toImportError(batch, item.row, item.rowNumber, error) : null;
  }).filter((item): item is ImportTaskError => Boolean(item));
}

function validateSkuFormat(rows: Array<{ rowNumber: number; row: OrderRow }>, batch: ImportTaskBatch) {
  return rows
    .filter(({ row }) => !/^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/.test(String(row.skuCode ?? "").trim()))
    .map(({ row, rowNumber }) => ({
      id: importUid("err"),
      taskId: batch.taskId,
      traceId: batch.traceId,
      unitId: batch.unitId,
      batchIndex: batch.batchIndex,
      rowNumber,
      fieldName: "skuCode",
      rawValue: maskValue("skuCode", row.skuCode),
      errorCode: "E_SKU_FORMAT",
      errorReason: "SKU 编码格式不正确，仅支持字母、数字、下划线和短横线",
      createdAt: nowIso()
    } satisfies ImportTaskError));
}

async function validateSkuMaster(rows: Array<{ rowNumber: number; row: OrderRow }>, batch: ImportTaskBatch) {
  const started = Date.now();
  try {
    const skuCodes = rows.map(({ row }) => String(row.skuCode ?? "").trim()).filter(Boolean);
    const existing = await importStore.listExistingSkus(skuCodes);
    const errors = rows
      .filter(({ row }) => row.skuCode && !existing.has(String(row.skuCode)))
      .map(({ row, rowNumber }) => ({
        id: importUid("err"),
        taskId: batch.taskId,
        traceId: batch.traceId,
        unitId: batch.unitId,
        batchIndex: batch.batchIndex,
        rowNumber,
        fieldName: "skuCode",
        rawValue: maskValue("skuCode", row.skuCode),
        errorCode: "E_SKU_NOT_FOUND",
        errorReason: "SKU 不存在于 sku_master 主数据",
        createdAt: nowIso()
      } satisfies ImportTaskError));
    return { errors, degraded: false, warning: undefined, durationMs: Date.now() - started };
  } catch {
    const errors = rows.map(({ row, rowNumber }) => ({
      id: importUid("err"),
      taskId: batch.taskId,
      traceId: batch.traceId,
      unitId: batch.unitId,
      batchIndex: batch.batchIndex,
      rowNumber,
      fieldName: "skuCode",
      rawValue: maskValue("skuCode", row.skuCode),
      errorCode: "W_SKU_VALIDATION_DEGRADED",
      errorReason: "SKU 主数据校验降级：本行未经过完整主数据校验",
      createdAt: nowIso()
    } satisfies ImportTaskError));
    return {
      errors,
      degraded: true,
      warning: "SKU 校验已降级：本次导入未经过商品主数据完整校验，数据可能需要后续复核。",
      durationMs: Date.now() - started
    };
  }
}

export async function processImportBatch(event: OutboxEvent) {
  const batch = await importStore.getBatchByEvent(event.payload);
  if (!batch) throw new Error("batch not found");
  if (batch.status === "SUCCEEDED") {
    await importStore.markOutboxSent(event.id);
    return { skipped: true, batch };
  }

  const totalStarted = Date.now();
  const claimed = await importStore.beginBatch(batch);
  if (!claimed) {
    await importStore.markOutboxSent(event.id);
    return { skipped: true, reason: "batch already claimed or completed", batch };
  }
  await importStore.addTrace({
    traceId: batch.traceId,
    taskId: batch.taskId,
    unitId: batch.unitId,
    eventName: "ImportBatchStarted",
    eventStatus: "INFO",
    message: `batch ${batch.batchIndex} rows ${batch.startRow}-${batch.endRow}`
  });

  const parseStarted = Date.now();
  const rows = await importStore.getRowsForBatch(batch.taskId, batch.unitId);
  const parseDurationMs = Date.now() - parseStarted;

  const ruleStarted = Date.now();
  const requiredErrors = validateRequired(rows, batch);
  const formatErrors = validateSkuFormat(rows, batch);
  const ruleDurationMs = Date.now() - ruleStarted;

  const validateResult = await validateSkuMaster(rows, batch);
  const allErrors = [...requiredErrors, ...formatErrors, ...validateResult.errors];
  const errorRowNumbers = new Set(allErrors.filter((error) => error.errorCode !== "W_SKU_VALIDATION_DEGRADED").map((error) => error.rowNumber));
  const validRows = rows.filter((item) => !errorRowNumbers.has(item.rowNumber)).map((item) => item.row);

  await importStore.addErrors(allErrors);

  const insertStarted = Date.now();
  await store.saveOrdersBulk(validRows);
  const insertDurationMs = Date.now() - insertStarted;

  const successRows = validRows.length;
  const failedRows = errorRowNumbers.size;
  const status = failedRows > 0 ? "SUCCEEDED" : "SUCCEEDED";
  await importStore.addPerformance({
    id: importUid("perf"),
    taskId: batch.taskId,
    traceId: batch.traceId,
    unitId: batch.unitId,
    batchIndex: batch.batchIndex,
    parseDurationMs,
    ruleDurationMs,
    validateDurationMs: validateResult.durationMs,
    insertDurationMs,
    totalDurationMs: Date.now() - totalStarted,
    status,
    createdAt: nowIso()
  });
  await importStore.completeBatch(batch, successRows, failedRows, validateResult.degraded, validateResult.warning);
  await importStore.markOutboxSent(event.id);
  await importStore.addTrace({
    traceId: batch.traceId,
    taskId: batch.taskId,
    unitId: batch.unitId,
    eventName: failedRows ? "ImportBatchPartialSucceeded" : "ImportBatchSucceeded",
    eventStatus: failedRows ? "WARN" : "SUCCESS",
    message: `success=${successRows}, failed=${failedRows}, fields=${Object.values(fieldLabels).length}`
  });
  return { batch, successRows, failedRows, degraded: validateResult.degraded };
}

export async function dispatchImportEvents(limit = 4) {
  const recovered = await importStore.recoverStaleBatches();
  const events = await importStore.claimOutboxEvents(limit);
  const results = [];
  for (const event of events) {
    try {
      results.push(await processImportBatch(event));
    } catch (error) {
      await importStore.markOutboxFailed(event.id, event.retryCount + 1);
      await importStore.addTrace({
        traceId: event.traceId,
        taskId: event.aggregateId,
        eventName: "ImportBatchFailed",
        eventStatus: "ERROR",
        message: error instanceof Error ? error.message : "unknown worker error"
      });
      results.push({ eventId: event.id, error: error instanceof Error ? error.message : "unknown worker error" });
    }
  }
  return { recovered, claimed: events.length, results };
}
