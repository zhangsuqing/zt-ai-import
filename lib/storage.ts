import { createPool } from "@vercel/postgres";
import { OrderRow, ParseRule } from "./types";

const rules: ParseRule[] = [];
const orders: OrderRow[] = [];

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const pool = connectionString ? createPool({ connectionString }) : null;
let initPromise: Promise<void> | null = null;
let databaseUnavailable = false;

function upsertMemoryOrders(rows: OrderRow[]) {
  for (const row of rows) {
    const index = orders.findIndex((item) => item.id === row.id);
    if (index >= 0) orders[index] = row;
    else orders.unshift(row);
  }
}

function markDatabaseUnavailable(error: unknown) {
  databaseUnavailable = true;
  initPromise = null;
  console.warn("Order database unavailable, fallback to memory store:", error instanceof Error ? error.message : error);
}

async function ensureTables() {
  if (!pool || databaseUnavailable) return;
  initPromise ??= (async () => {
    await pool.sql`
      CREATE TABLE IF NOT EXISTS parse_rules (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pool.sql`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        external_code TEXT NOT NULL,
        receiver_name TEXT,
        store_name TEXT,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pool.sql`CREATE INDEX IF NOT EXISTS orders_external_code_idx ON orders (external_code)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS orders_receiver_name_idx ON orders (receiver_name)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS orders_store_name_idx ON orders (store_name)`;
  })();
  await initPromise;
}

export const store = {
  isDatabaseEnabled: () => Boolean(pool) && !databaseUnavailable,
  listRules: async () => {
    if (!pool || databaseUnavailable) return rules;
    await ensureTables();
    const result = await pool.sql`SELECT payload FROM parse_rules ORDER BY updated_at DESC`;
    return result.rows.map((row) => row.payload as ParseRule);
  },
  saveRule: async (rule: ParseRule) => {
    if (!pool || databaseUnavailable) {
      const index = rules.findIndex((item) => item.id === rule.id);
      if (index >= 0) rules[index] = rule;
      else rules.unshift(rule);
      return rule;
    }
    await ensureTables();
    await pool.sql`
      INSERT INTO parse_rules (id, payload, updated_at)
      VALUES (${rule.id}, ${JSON.stringify(rule)}::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
    `;
    return rule;
  },
  deleteRule: async (id: string) => {
    if (!pool || databaseUnavailable) {
      const index = rules.findIndex((rule) => rule.id === id);
      if (index >= 0) rules.splice(index, 1);
      return;
    }
    await ensureTables();
    await pool.sql`DELETE FROM parse_rules WHERE id = ${id}`;
  },
  listOrders: async (keyword = "") => {
    if (!pool || databaseUnavailable) {
      return orders.filter((row) => {
        if (!keyword) return true;
        return [row.externalCode, row.receiverName, row.storeName, row.receiverPhone].some((value) => value.includes(keyword));
      });
    }
    await ensureTables();
    if (!keyword) {
      const result = await pool.sql`SELECT payload FROM orders ORDER BY created_at DESC LIMIT 500`;
      return result.rows.map((row) => row.payload as OrderRow);
    }
    const like = `%${keyword}%`;
    const result = await pool.sql`
      SELECT payload FROM orders
      WHERE external_code ILIKE ${like}
         OR receiver_name ILIKE ${like}
         OR store_name ILIKE ${like}
         OR payload->>'receiverPhone' ILIKE ${like}
      ORDER BY created_at DESC
      LIMIT 500
    `;
    return result.rows.map((row) => row.payload as OrderRow);
  },
  saveOrders: async (rows: OrderRow[]) => {
    if (!pool || databaseUnavailable) {
      upsertMemoryOrders(rows);
      return rows;
    }
    await ensureTables();
    for (const row of rows) {
      await pool.sql`
        INSERT INTO orders (id, external_code, receiver_name, store_name, payload, created_at)
        VALUES (${row.id}, ${row.externalCode}, ${row.receiverName}, ${row.storeName}, ${JSON.stringify(row)}::jsonb, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          external_code = EXCLUDED.external_code,
          receiver_name = EXCLUDED.receiver_name,
          store_name = EXCLUDED.store_name,
          payload = EXCLUDED.payload
      `;
    }
    return rows;
  },
  saveOrdersBulk: async (rows: OrderRow[]) => {
    if (!rows.length) return rows;
    if (!pool || databaseUnavailable) {
      upsertMemoryOrders(rows);
      return rows;
    }
    try {
      await ensureTables();
      if (databaseUnavailable) {
        upsertMemoryOrders(rows);
        return rows;
      }
      await pool.query(
        `INSERT INTO orders (id, external_code, receiver_name, store_name, payload, created_at)
         SELECT id, external_code, receiver_name, store_name, payload, NOW()
         FROM jsonb_to_recordset($1::jsonb)
         AS x(id text, external_code text, receiver_name text, store_name text, payload jsonb)
         ON CONFLICT (id)
         DO UPDATE SET
           external_code = EXCLUDED.external_code,
           receiver_name = EXCLUDED.receiver_name,
           store_name = EXCLUDED.store_name,
           payload = EXCLUDED.payload`,
        [JSON.stringify(rows.map((row) => ({
          id: row.id,
          external_code: row.externalCode,
          receiver_name: row.receiverName,
          store_name: row.storeName,
          payload: row
        })))]
      );
      return rows;
    } catch (error) {
      markDatabaseUnavailable(error);
      upsertMemoryOrders(rows);
      return rows;
    }
  },
  clearOrders: async () => {
    if (!pool || databaseUnavailable) {
      orders.splice(0, orders.length);
      return;
    }
    await ensureTables();
    await pool.sql`DELETE FROM orders`;
  }
};

export const memoryStore = {
  listRules: () => rules,
  saveRule: (rule: ParseRule) => {
    const index = rules.findIndex((item) => item.id === rule.id);
    if (index >= 0) rules[index] = rule;
    else rules.unshift(rule);
    return rule;
  },
  deleteRule: (id: string) => {
    const index = rules.findIndex((rule) => rule.id === id);
    if (index >= 0) rules.splice(index, 1);
  },
  listOrders: () => orders,
  saveOrders: (rows: OrderRow[]) => {
    upsertMemoryOrders(rows);
    return rows;
  },
  clearOrders: () => {
    orders.splice(0, orders.length);
  }
};
