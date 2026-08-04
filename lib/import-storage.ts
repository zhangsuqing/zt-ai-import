import { createPool } from "@vercel/postgres";
import { OrderRow } from "./types";
import {
  BatchPerformanceLog,
  ImportBatchStatus,
  ImportTask,
  ImportTaskBatch,
  ImportTaskCreateInput,
  ImportTaskError,
  ImportTaskStatus,
  OutboxEvent,
  TraceEvent
} from "./import-types";

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const pool = connectionString ? createPool({ connectionString }) : null;
let initPromise: Promise<void> | null = null;
let databaseUnavailable = false;

const tasks = new Map<string, ImportTask>();
const batches = new Map<string, ImportTaskBatch>();
const taskRows = new Map<string, OrderRow[]>();
const errors: ImportTaskError[] = [];
const perfLogs: BatchPerformanceLog[] = [];
const traces: TraceEvent[] = [];
const outbox = new Map<string, OutboxEvent>();
const skuMaster = new Set<string>();
const STALE_BATCH_MINUTES = Number(process.env.IMPORT_STALE_BATCH_MINUTES ?? 10);

export const importUid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const nowIso = () => new Date().toISOString();

function markDatabaseUnavailable(error: unknown) {
  databaseUnavailable = true;
  initPromise = null;
  console.warn("Import database unavailable, fallback to memory store:", error instanceof Error ? error.message : error);
}

function persistImportTaskInMemory(task: ImportTask, batchList: ImportTaskBatch[], rows: OrderRow[], events: OutboxEvent[]) {
  tasks.set(task.id, task);
  batchList.forEach((batch) => batches.set(batch.id, batch));
  taskRows.set(task.id, rows);
  events.forEach((event) => outbox.set(event.id, event));
  traces.push({ id: importUid("trc"), traceId: task.traceId, taskId: task.id, eventName: "ImportTaskCreated", eventStatus: "INFO", message: `created ${task.totalBatches} batches`, occurredAt: nowIso() });
  return { task, batches: batchList };
}

async function ensureImportTables() {
  if (!pool || databaseUnavailable) return;
  initPromise ??= (async () => {
    await pool.sql`
      CREATE TABLE IF NOT EXISTS sku_master (
        id TEXT PRIMARY KEY,
        sku_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        spec TEXT,
        unit TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS import_tasks (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        status TEXT NOT NULL,
        total_rows INTEGER NOT NULL DEFAULT 0,
        processed_rows INTEGER NOT NULL DEFAULT 0,
        success_rows INTEGER NOT NULL DEFAULT 0,
        failed_rows INTEGER NOT NULL DEFAULT 0,
        total_batches INTEGER NOT NULL DEFAULT 0,
        completed_batches INTEGER NOT NULL DEFAULT 0,
        trace_id TEXT NOT NULL,
        degraded BOOLEAN NOT NULL DEFAULT FALSE,
        warning TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS import_task_batches (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        batch_index INTEGER NOT NULL,
        start_row INTEGER NOT NULL,
        end_row INTEGER NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        locked_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT,
        UNIQUE(task_id, unit_id)
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS import_task_rows (
        task_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        unit_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        PRIMARY KEY(task_id, row_number)
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS import_task_errors (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        batch_index INTEGER NOT NULL,
        row_number INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        raw_value TEXT,
        error_code TEXT NOT NULL,
        error_reason TEXT NOT NULL,
        rule_id TEXT,
        trace_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS event_outbox (
        id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        trace_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS batch_performance_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        batch_index INTEGER NOT NULL,
        parse_duration_ms INTEGER NOT NULL,
        rule_duration_ms INTEGER NOT NULL,
        validate_duration_ms INTEGER NOT NULL,
        insert_duration_ms INTEGER NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        task_id TEXT,
        unit_id TEXT,
        event_name TEXT NOT NULL,
        event_status TEXT NOT NULL,
        message TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pool.sql`CREATE INDEX IF NOT EXISTS import_tasks_status_created_idx ON import_tasks(status, created_at)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS import_task_errors_task_unit_idx ON import_task_errors(task_id, unit_id)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS import_task_errors_code_idx ON import_task_errors(error_code)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS event_outbox_status_retry_idx ON event_outbox(status, next_retry_at)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS batch_performance_task_unit_idx ON batch_performance_log(task_id, unit_id)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS trace_events_trace_time_idx ON trace_events(trace_id, occurred_at)`;
  })();
  await initPromise;
}

function toTask(row: Record<string, unknown>): ImportTask {
  return {
    id: String(row.id),
    traceId: String(row.trace_id),
    fileName: String(row.file_name),
    ruleId: String(row.rule_id),
    status: String(row.status) as ImportTaskStatus,
    totalRows: Number(row.total_rows),
    processedRows: Number(row.processed_rows),
    successRows: Number(row.success_rows),
    failedRows: Number(row.failed_rows),
    totalBatches: Number(row.total_batches),
    completedBatches: Number(row.completed_batches),
    degraded: Boolean(row.degraded),
    warning: row.warning ? String(row.warning) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : undefined
  };
}

function toBatch(row: Record<string, unknown>): ImportTaskBatch {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    traceId: String(row.trace_id),
    unitId: String(row.unit_id),
    batchIndex: Number(row.batch_index),
    startRow: Number(row.start_row),
    endRow: Number(row.end_row),
    status: String(row.status) as ImportBatchStatus,
    retryCount: Number(row.retry_count),
    lockedAt: row.locked_at ? new Date(String(row.locked_at)).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined
  };
}

export const importStore = {
  isDatabaseEnabled: () => Boolean(pool) && !databaseUnavailable,
  ensure: ensureImportTables,

  clearImportData: async () => {
    tasks.clear();
    batches.clear();
    taskRows.clear();
    errors.splice(0, errors.length);
    perfLogs.splice(0, perfLogs.length);
    traces.splice(0, traces.length);
    outbox.clear();
    if (!pool || databaseUnavailable) return;
    await ensureImportTables();
    await pool.query(`
      TRUNCATE TABLE
        import_task_errors,
        batch_performance_log,
        trace_events,
        event_outbox,
        import_task_rows,
        import_task_batches,
        import_tasks
    `);
  },

  createTask: async (input: ImportTaskCreateInput) => {
    const batchSize = Math.max(100, input.batchSize ?? Number(process.env.IMPORT_BATCH_SIZE ?? 1000));
    const id = importUid("task");
    const traceId = importUid("trace");
    const createdAt = nowIso();
    const totalBatches = Math.max(1, Math.ceil(input.rows.length / batchSize));
    const task: ImportTask = {
      id,
      traceId,
      fileName: input.fileName,
      ruleId: input.ruleId,
      status: "PENDING",
      totalRows: input.rows.length,
      processedRows: 0,
      successRows: 0,
      failedRows: 0,
      totalBatches,
      completedBatches: 0,
      degraded: false,
      createdAt,
      updatedAt: createdAt
    };
    const batchList: ImportTaskBatch[] = Array.from({ length: totalBatches }, (_, index) => {
      const startRow = index * batchSize + 1;
      const endRow = Math.min(input.rows.length, (index + 1) * batchSize);
      return {
        id: importUid("batch"),
        taskId: id,
        traceId,
        unitId: `unit_${String(index + 1).padStart(4, "0")}`,
        batchIndex: index + 1,
        startRow,
        endRow,
        status: "PENDING",
        retryCount: 0
      };
    });
    const events: OutboxEvent[] = batchList.map((batch) => ({
      id: importUid("evt"),
      aggregateId: id,
      eventType: "ImportBatchCreated",
      schemaVersion: 1,
      traceId,
      payload: {
        task_id: id,
        unit_id: batch.unitId,
        batch_id: batch.id,
        batch_index: batch.batchIndex,
        start_row: batch.startRow,
        end_row: batch.endRow
      },
      status: "PENDING",
      retryCount: 0,
      nextRetryAt: createdAt,
      createdAt
    }));

    if (!pool || databaseUnavailable) return persistImportTaskInMemory(task, batchList, input.rows, events);

    try {
      await ensureImportTables();
      const batchPayload = JSON.stringify(batchList.map((batch) => ({
      id: batch.id,
      task_id: batch.taskId,
      trace_id: batch.traceId,
      unit_id: batch.unitId,
      batch_index: batch.batchIndex,
      start_row: batch.startRow,
      end_row: batch.endRow,
      status: batch.status
      })));
      const rowPayload = JSON.stringify(input.rows.map((row, index) => {
      const batchIndex = Math.floor(index / batchSize);
      return { task_id: id, row_number: index + 1, unit_id: batchList[batchIndex].unitId, payload: row };
      }));
      const eventPayload = JSON.stringify(events.map((event) => ({
      id: event.id,
      aggregate_id: event.aggregateId,
      event_type: event.eventType,
      schema_version: event.schemaVersion,
      trace_id: event.traceId,
      payload: event.payload,
      status: event.status,
      retry_count: event.retryCount,
      next_retry_at: event.nextRetryAt,
      created_at: event.createdAt
      })));
      await pool.query(
      `WITH inserted_task AS (
         INSERT INTO import_tasks (id, file_name, rule_id, status, total_rows, total_batches, trace_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
         RETURNING id
       ), inserted_batches AS (
         INSERT INTO import_task_batches (id, task_id, trace_id, unit_id, batch_index, start_row, end_row, status)
         SELECT * FROM jsonb_to_recordset($8::jsonb)
         AS x(id text, task_id text, trace_id text, unit_id text, batch_index int, start_row int, end_row int, status text)
         RETURNING id
       ), inserted_rows AS (
         INSERT INTO import_task_rows (task_id, row_number, unit_id, payload)
         SELECT * FROM jsonb_to_recordset($9::jsonb)
         AS x(task_id text, row_number int, unit_id text, payload jsonb)
         ON CONFLICT (task_id, row_number) DO UPDATE SET payload = EXCLUDED.payload
         RETURNING task_id
       ), inserted_events AS (
         INSERT INTO event_outbox (id, aggregate_id, event_type, schema_version, trace_id, payload, status, retry_count, next_retry_at, created_at)
         SELECT * FROM jsonb_to_recordset($10::jsonb)
         AS x(id text, aggregate_id text, event_type text, schema_version int, trace_id text, payload jsonb, status text, retry_count int, next_retry_at timestamptz, created_at timestamptz)
         RETURNING id
       )
       INSERT INTO trace_events (id, trace_id, task_id, event_name, event_status, message, occurred_at)
       VALUES ($11,$7,$1,'ImportTaskCreated','INFO',$12,NOW())`,
      [task.id, task.fileName, task.ruleId, task.status, task.totalRows, task.totalBatches, task.traceId, batchPayload, rowPayload, eventPayload, importUid("trc"), `created ${totalBatches} batches`]
      );
      return { task, batches: batchList };
    } catch (error) {
      markDatabaseUnavailable(error);
      return persistImportTaskInMemory(task, batchList, input.rows, events);
    }
  },

  listTasks: async (limit = 20) => {
    if (!pool || databaseUnavailable) return Array.from(tasks.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    try {
      await ensureImportTables();
      if (databaseUnavailable) return Array.from(tasks.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      const result = await pool.query("SELECT * FROM import_tasks ORDER BY created_at DESC LIMIT $1", [limit]);
      return result.rows.map(toTask);
    } catch (error) {
      markDatabaseUnavailable(error);
      return Array.from(tasks.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    }
  },

  getTask: async (taskId: string) => {
    if (!pool || databaseUnavailable) return tasks.get(taskId) ?? null;
    await ensureImportTables();
    const result = await pool.query("SELECT * FROM import_tasks WHERE id = $1", [taskId]);
    return result.rows[0] ? toTask(result.rows[0]) : null;
  },

  getBatches: async (taskId: string) => {
    if (!pool || databaseUnavailable) return Array.from(batches.values()).filter((batch) => batch.taskId === taskId).sort((a, b) => a.batchIndex - b.batchIndex);
    await ensureImportTables();
    const result = await pool.query("SELECT * FROM import_task_batches WHERE task_id = $1 ORDER BY batch_index", [taskId]);
    return result.rows.map(toBatch);
  },

  getBatchByEvent: async (payload: Record<string, unknown>) => {
    const batchId = String(payload.batch_id ?? "");
    if (!pool || databaseUnavailable) return batches.get(batchId) ?? null;
    await ensureImportTables();
    const result = await pool.query("SELECT * FROM import_task_batches WHERE id = $1", [batchId]);
    return result.rows[0] ? toBatch(result.rows[0]) : null;
  },

  recoverStaleBatches: async (staleMinutes = STALE_BATCH_MINUTES) => {
    if (!pool || databaseUnavailable) {
      const cutoff = Date.now() - staleMinutes * 60_000;
      let recovered = 0;
      for (const [id, batch] of batches.entries()) {
        if (batch.status !== "PROCESSING") continue;
        if (!batch.lockedAt || Date.parse(batch.lockedAt) > cutoff) continue;
        batches.set(id, {
          ...batch,
          status: "FAILED",
          retryCount: batch.retryCount + 1,
          errorMessage: `stale processing batch recovered after ${staleMinutes} minutes`
        });
        traces.push({
          id: importUid("trc"),
          traceId: batch.traceId,
          taskId: batch.taskId,
          unitId: batch.unitId,
          eventName: "ImportBatchRecovered",
          eventStatus: "WARN",
          message: `stale batch recovered after ${staleMinutes} minutes`,
          occurredAt: nowIso()
        });
        recovered += 1;
      }
      return recovered;
    }
    await ensureImportTables();
    const result = await pool.query(
      `UPDATE import_task_batches
       SET status = 'FAILED',
           retry_count = retry_count + 1,
           error_message = 'stale processing batch recovered',
           locked_at = NULL
       WHERE status = 'PROCESSING'
         AND locked_at < NOW() - ($1::int * INTERVAL '1 minute')
       RETURNING id, trace_id, task_id, unit_id`,
      [staleMinutes]
    );
    await Promise.all(result.rows.map((row) => pool.query(
      "INSERT INTO trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
      [importUid("trc"), row.trace_id, row.task_id, row.unit_id, "ImportBatchRecovered", "WARN", `stale batch recovered after ${staleMinutes} minutes`]
    )));
    return result.rowCount ?? 0;
  },

  getRowsForBatch: async (taskId: string, unitId: string) => {
    if (!pool || databaseUnavailable) return (taskRows.get(taskId) ?? []).map((row, index) => ({ rowNumber: index + 1, row })).filter((item) => {
      const batch = Array.from(batches.values()).find((candidate) => candidate.taskId === taskId && candidate.unitId === unitId);
      return batch ? item.rowNumber >= batch.startRow && item.rowNumber <= batch.endRow : false;
    });
    await ensureImportTables();
    const result = await pool.query("SELECT row_number, payload FROM import_task_rows WHERE task_id = $1 AND unit_id = $2 ORDER BY row_number", [taskId, unitId]);
    return result.rows.map((row) => ({ rowNumber: Number(row.row_number), row: row.payload as OrderRow }));
  },

  claimOutboxEvents: async (limit = 4) => {
    if (!pool || databaseUnavailable) {
      return Array.from(outbox.values())
        .filter((event) => event.status === "PENDING")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    }
    await ensureImportTables();
    const result = await pool.query(
      `SELECT * FROM event_outbox
       WHERE status = 'PENDING' AND next_retry_at <= NOW()
       ORDER BY created_at
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      schemaVersion: Number(row.schema_version),
      traceId: row.trace_id,
      payload: row.payload,
      status: row.status,
      retryCount: Number(row.retry_count),
      nextRetryAt: new Date(row.next_retry_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : undefined
    } as OutboxEvent));
  },

  markOutboxSent: async (eventId: string) => {
    if (!pool || databaseUnavailable) {
      const event = outbox.get(eventId);
      if (event) outbox.set(eventId, { ...event, status: "SENT", sentAt: nowIso() });
      return;
    }
    await ensureImportTables();
    await pool.query("UPDATE event_outbox SET status = 'SENT', sent_at = NOW() WHERE id = $1", [eventId]);
  },

  markOutboxFailed: async (eventId: string, retryCount: number) => {
    if (!pool || databaseUnavailable) {
      const event = outbox.get(eventId);
      if (event) outbox.set(eventId, { ...event, status: retryCount >= 3 ? "FAILED" : "PENDING", retryCount, nextRetryAt: nowIso() });
      return;
    }
    await ensureImportTables();
    await pool.query(
      "UPDATE event_outbox SET status = CASE WHEN $2 >= 3 THEN 'FAILED' ELSE 'PENDING' END, retry_count = $2, next_retry_at = NOW() + INTERVAL '5 seconds' WHERE id = $1",
      [eventId, retryCount]
    );
  },

  beginBatch: async (batch: ImportTaskBatch) => {
    if (!pool || databaseUnavailable) {
      const current = batches.get(batch.id);
      if (!current || !["PENDING", "QUEUED", "FAILED"].includes(current.status)) return false;
      batches.set(batch.id, { ...current, status: "PROCESSING", lockedAt: nowIso() });
      const task = tasks.get(batch.taskId);
      if (task && task.status === "PENDING") tasks.set(task.id, { ...task, status: "PROCESSING", updatedAt: nowIso() });
      return true;
    }
    await ensureImportTables();
    const claimed = await pool.query(
      "UPDATE import_task_batches SET status = 'PROCESSING', locked_at = NOW() WHERE id = $1 AND status IN ('PENDING','QUEUED','FAILED') RETURNING id",
      [batch.id]
    );
    if (!claimed.rowCount) return false;
    await pool.query("UPDATE import_tasks SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1 AND status = 'PENDING'", [batch.taskId]);
    return true;
  },

  completeBatch: async (batch: ImportTaskBatch, successRows: number, failedRows: number, degraded: boolean, warning?: string) => {
    if (!pool || databaseUnavailable) {
      const current = batches.get(batch.id);
      if (!current || current.status === "SUCCEEDED") return false;
      batches.set(batch.id, { ...current, status: "SUCCEEDED", completedAt: nowIso() });
      const task = tasks.get(batch.taskId);
      if (task) {
        const next: ImportTask = {
          ...task,
          processedRows: task.processedRows + successRows + failedRows,
          successRows: task.successRows + successRows,
          failedRows: task.failedRows + failedRows,
          completedBatches: task.completedBatches + 1,
          degraded: task.degraded || degraded,
          warning: warning ?? task.warning,
          updatedAt: nowIso()
        };
        if (next.completedBatches >= next.totalBatches) {
          next.status = next.failedRows > 0 ? "PARTIAL_SUCCESS" : "COMPLETED";
          next.completedAt = nowIso();
        }
        tasks.set(task.id, next);
      }
      return true;
    }
    await ensureImportTables();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const completed = await client.query(
        "UPDATE import_task_batches SET status = 'SUCCEEDED', completed_at = NOW() WHERE id = $1 AND status <> 'SUCCEEDED' RETURNING id",
        [batch.id]
      );
      if (!completed.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE import_tasks
         SET processed_rows = processed_rows + $2,
             success_rows = success_rows + $3,
             failed_rows = failed_rows + $4,
             completed_batches = completed_batches + 1,
             degraded = degraded OR $5,
             warning = COALESCE($6, warning),
             updated_at = NOW()
         WHERE id = $1`,
        [batch.taskId, successRows + failedRows, successRows, failedRows, degraded, warning ?? null]
      );
      await client.query(
        `UPDATE import_tasks
         SET status = CASE WHEN failed_rows > 0 THEN 'PARTIAL_SUCCESS' ELSE 'COMPLETED' END,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND completed_batches >= total_batches`,
        [batch.taskId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  failBatch: async (batch: ImportTaskBatch, message: string) => {
    if (!pool || databaseUnavailable) {
      batches.set(batch.id, { ...batch, status: "FAILED", retryCount: batch.retryCount + 1, errorMessage: message });
      return;
    }
    await ensureImportTables();
    await pool.query("UPDATE import_task_batches SET status = 'FAILED', retry_count = retry_count + 1, error_message = $2 WHERE id = $1", [batch.id, message]);
  },

  listExistingSkus: async (skuCodes: string[]) => {
    const unique = Array.from(new Set(skuCodes.filter(Boolean)));
    if (!unique.length) return new Set<string>();
    if (!pool || databaseUnavailable) return new Set(unique.filter((code) => skuMaster.has(code)));
    await ensureImportTables();
    const started = Date.now();
    const result = await pool.query("SELECT sku_code FROM sku_master WHERE sku_code = ANY($1::text[])", [unique]);
    if (Date.now() - started > 3000) throw new Error("SKU_MASTER_TIMEOUT");
    return new Set<string>(result.rows.map((row) => row.sku_code));
  },

  addErrors: async (items: ImportTaskError[]) => {
    if (!items.length) return;
    if (!pool || databaseUnavailable) {
      errors.push(...items);
      return;
    }
    await ensureImportTables();
    await pool.query(
      `INSERT INTO import_task_errors (id, task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, rule_id, trace_id, created_at)
       SELECT * FROM jsonb_to_recordset($1::jsonb)
       AS x(id text, task_id text, unit_id text, batch_index int, row_number int, field_name text, raw_value text, error_code text, error_reason text, rule_id text, trace_id text, created_at timestamptz)`,
      [JSON.stringify(items.map((item) => ({
        id: item.id,
        task_id: item.taskId,
        unit_id: item.unitId,
        batch_index: item.batchIndex,
        row_number: item.rowNumber,
        field_name: item.fieldName,
        raw_value: item.rawValue,
        error_code: item.errorCode,
        error_reason: item.errorReason,
        rule_id: item.ruleId ?? null,
        trace_id: item.traceId,
        created_at: item.createdAt
      })))]
    );
  },

  listErrors: async (taskId: string, params?: { batch?: number; errorCode?: string; page?: number; pageSize?: number }) => {
    if (!pool || databaseUnavailable) {
      return errors.filter((item) => item.taskId === taskId)
        .filter((item) => !params?.batch || item.batchIndex === params.batch)
        .filter((item) => !params?.errorCode || item.errorCode === params.errorCode)
        .slice(((params?.page ?? 1) - 1) * (params?.pageSize ?? 50), (params?.page ?? 1) * (params?.pageSize ?? 50));
    }
    await ensureImportTables();
    const page = Math.max(1, params?.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params?.pageSize ?? 50));
    const result = await pool.query(
      `SELECT * FROM import_task_errors
       WHERE task_id = $1
         AND ($2::int IS NULL OR batch_index = $2)
         AND ($3::text IS NULL OR error_code = $3)
       ORDER BY row_number
       LIMIT $4 OFFSET $5`,
      [taskId, params?.batch ?? null, params?.errorCode ?? null, pageSize, (page - 1) * pageSize]
    );
    return result.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      traceId: row.trace_id,
      unitId: row.unit_id,
      batchIndex: Number(row.batch_index),
      rowNumber: Number(row.row_number),
      fieldName: row.field_name,
      rawValue: row.raw_value ?? "",
      errorCode: row.error_code,
      errorReason: row.error_reason,
      ruleId: row.rule_id ?? undefined,
      createdAt: new Date(row.created_at).toISOString()
    } as ImportTaskError));
  },

  addPerformance: async (log: BatchPerformanceLog) => {
    if (!pool || databaseUnavailable) {
      perfLogs.push(log);
      return;
    }
    await ensureImportTables();
    await pool.query(
      `INSERT INTO batch_performance_log
       (id, task_id, unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms, insert_duration_ms, total_duration_ms, status, trace_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      [log.id, log.taskId, log.unitId, log.batchIndex, log.parseDurationMs, log.ruleDurationMs, log.validateDurationMs, log.insertDurationMs, log.totalDurationMs, log.status, log.traceId]
    );
  },

  listPerformance: async (taskId: string) => {
    if (!pool || databaseUnavailable) return perfLogs.filter((item) => item.taskId === taskId).sort((a, b) => a.batchIndex - b.batchIndex);
    await ensureImportTables();
    const result = await pool.query("SELECT * FROM batch_performance_log WHERE task_id = $1 ORDER BY batch_index", [taskId]);
    return result.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      traceId: row.trace_id,
      unitId: row.unit_id,
      batchIndex: Number(row.batch_index),
      parseDurationMs: Number(row.parse_duration_ms),
      ruleDurationMs: Number(row.rule_duration_ms),
      validateDurationMs: Number(row.validate_duration_ms),
      insertDurationMs: Number(row.insert_duration_ms),
      totalDurationMs: Number(row.total_duration_ms),
      status: row.status,
      createdAt: new Date(row.created_at).toISOString()
    } as BatchPerformanceLog));
  },

  addTrace: async (event: Omit<TraceEvent, "id" | "occurredAt">) => {
    const item: TraceEvent = { ...event, id: importUid("trc"), occurredAt: nowIso() };
    if (!pool || databaseUnavailable) {
      traces.push(item);
      return;
    }
    await ensureImportTables();
    await pool.query(
      "INSERT INTO trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
      [item.id, item.traceId, item.taskId ?? null, item.unitId ?? null, item.eventName, item.eventStatus, item.message]
    );
  },

  listTraces: async (traceId: string) => {
    if (!pool || databaseUnavailable) return traces.filter((item) => item.traceId === traceId).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    await ensureImportTables();
    const result = await pool.query("SELECT * FROM trace_events WHERE trace_id = $1 ORDER BY occurred_at", [traceId]);
    return result.rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      taskId: row.task_id ?? undefined,
      unitId: row.unit_id ?? undefined,
      eventName: row.event_name,
      eventStatus: row.event_status,
      message: row.message,
      occurredAt: new Date(row.occurred_at).toISOString()
    } as TraceEvent));
  },

  searchTraces: async (params: { taskId?: string; traceId?: string; fileName?: string; batch?: number; rowFrom?: number; rowTo?: number; errorCode?: string }) => {
    if (!pool || databaseUnavailable) {
      const taskIdsByFile = new Set(Array.from(tasks.values())
        .filter((task) => !params.fileName || task.fileName.includes(params.fileName))
        .map((task) => task.id));
      const taskIdsByError = new Set(errors
        .filter((error) => !params.errorCode || error.errorCode === params.errorCode)
        .filter((error) => !params.batch || error.batchIndex === params.batch)
        .filter((error) => !params.rowFrom || error.rowNumber >= params.rowFrom)
        .filter((error) => !params.rowTo || error.rowNumber <= params.rowTo)
        .map((error) => error.taskId));
      return traces
        .filter((event) => !params.traceId || event.traceId === params.traceId)
        .filter((event) => !params.taskId || event.taskId === params.taskId)
        .filter((event) => !params.fileName || (event.taskId && taskIdsByFile.has(event.taskId)))
        .filter((event) => !params.errorCode || (event.taskId && taskIdsByError.has(event.taskId)))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    }
    await ensureImportTables();
    const result = await pool.query(
      `SELECT DISTINCT te.*
       FROM trace_events te
       LEFT JOIN import_tasks it ON it.id = te.task_id
       LEFT JOIN import_task_errors err ON err.task_id = te.task_id
       WHERE ($1::text IS NULL OR te.trace_id = $1)
         AND ($2::text IS NULL OR te.task_id = $2)
         AND ($3::text IS NULL OR it.file_name ILIKE '%' || $3 || '%')
         AND ($4::int IS NULL OR err.batch_index = $4)
         AND ($5::int IS NULL OR err.row_number >= $5)
         AND ($6::int IS NULL OR err.row_number <= $6)
         AND ($7::text IS NULL OR err.error_code = $7)
       ORDER BY te.occurred_at
       LIMIT 200`,
      [params.traceId ?? null, params.taskId ?? null, params.fileName ?? null, params.batch ?? null, params.rowFrom ?? null, params.rowTo ?? null, params.errorCode ?? null]
    );
    return result.rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      taskId: row.task_id ?? undefined,
      unitId: row.unit_id ?? undefined,
      eventName: row.event_name,
      eventStatus: row.event_status,
      message: row.message,
      occurredAt: new Date(row.occurred_at).toISOString()
    } as TraceEvent));
  },

  monitorSummary: async () => {
    const percentile = (values: number[], p: number) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
    };
    const stageStats = (logs: BatchPerformanceLog[]) => ({
      parse: {
        p50: percentile(logs.map((item) => item.parseDurationMs), 50),
        p95: percentile(logs.map((item) => item.parseDurationMs), 95),
        p99: percentile(logs.map((item) => item.parseDurationMs), 99)
      },
      rule: {
        p50: percentile(logs.map((item) => item.ruleDurationMs), 50),
        p95: percentile(logs.map((item) => item.ruleDurationMs), 95),
        p99: percentile(logs.map((item) => item.ruleDurationMs), 99)
      },
      validate: {
        p50: percentile(logs.map((item) => item.validateDurationMs), 50),
        p95: percentile(logs.map((item) => item.validateDurationMs), 95),
        p99: percentile(logs.map((item) => item.validateDurationMs), 99)
      },
      insert: {
        p50: percentile(logs.map((item) => item.insertDurationMs), 50),
        p95: percentile(logs.map((item) => item.insertDurationMs), 95),
        p99: percentile(logs.map((item) => item.insertDurationMs), 99)
      },
      total: {
        p50: percentile(logs.map((item) => item.totalDurationMs), 50),
        p95: percentile(logs.map((item) => item.totalDurationMs), 95),
        p99: percentile(logs.map((item) => item.totalDurationMs), 99)
      }
    });
    if (!pool || databaseUnavailable) {
      const allTasks = Array.from(tasks.values());
      const pendingEvents = Array.from(outbox.values()).filter((event) => event.status === "PENDING").length;
      const errorCounts = errors.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.errorCode]: (acc[item.errorCode] ?? 0) + 1 }), {});
      const errorCountRows = Object.entries(errorCounts).map(([error_code, count]) => ({ error_code, count }));
      const recentPerformance = perfLogs.slice(-20);
      const throughputRowsPerMinute = allTasks
        .filter((task) => Date.now() - Date.parse(task.updatedAt) <= 5 * 60_000)
        .reduce((sum, task) => sum + task.successRows, 0) / 5;
      return {
        database: false,
        tasks: allTasks,
        pendingEvents,
        queueAlert: pendingEvents > 5 ? "WARN" : "OK",
        throughputRowsPerMinute,
        errorCounts: errorCountRows,
        stageStats: stageStats(recentPerformance),
        recentPerformance
      };
    }
    await ensureImportTables();
    if (databaseUnavailable) {
      const allTasks = Array.from(tasks.values());
      const pendingEvents = Array.from(outbox.values()).filter((event) => event.status === "PENDING").length;
      const recentPerformance = perfLogs.slice(-20);
      return { database: false, tasks: allTasks, pendingEvents, queueAlert: pendingEvents > 5 ? "WARN" : "OK", throughputRowsPerMinute: 0, errorCounts: [], stageStats: stageStats(recentPerformance), recentPerformance };
    }
    const [taskStatus, pending, errorCodes, performance, throughput] = await Promise.all([
      pool.query("SELECT status, count(*)::int count FROM import_tasks GROUP BY status"),
      pool.query("SELECT count(*)::int count FROM event_outbox WHERE status = 'PENDING'"),
      pool.query("SELECT error_code, count(*)::int count FROM import_task_errors GROUP BY error_code ORDER BY count DESC LIMIT 10"),
      pool.query("SELECT * FROM batch_performance_log ORDER BY created_at DESC LIMIT 50"),
      pool.query("SELECT COALESCE(SUM(success_rows), 0)::int rows FROM import_tasks WHERE updated_at >= NOW() - INTERVAL '5 minutes'")
    ]);
    const recentPerformance = performance.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      traceId: row.trace_id,
      unitId: row.unit_id,
      batchIndex: Number(row.batch_index),
      parseDurationMs: Number(row.parse_duration_ms),
      ruleDurationMs: Number(row.rule_duration_ms),
      validateDurationMs: Number(row.validate_duration_ms),
      insertDurationMs: Number(row.insert_duration_ms),
      totalDurationMs: Number(row.total_duration_ms),
      status: row.status,
      createdAt: new Date(row.created_at).toISOString()
    } as BatchPerformanceLog));
    return {
      database: true,
      taskStatus: taskStatus.rows,
      pendingEvents: pending.rows[0]?.count ?? 0,
      queueAlert: Number(pending.rows[0]?.count ?? 0) > 5 ? "WARN" : "OK",
      throughputRowsPerMinute: Number(throughput.rows[0]?.rows ?? 0) / 5,
      errorCounts: errorCodes.rows,
      stageStats: stageStats(recentPerformance),
      recentPerformance
    };
  }
};
