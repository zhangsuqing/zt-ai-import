import { createPool } from "@vercel/postgres";
import { OrderRow, ParseRule } from "./types";

const rules: ParseRule[] = [];
const orders: OrderRow[] = [];

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const pool = connectionString ? createPool({ connectionString }) : null;
let initPromise: Promise<void> | null = null;
let ruleInitPromise: Promise<void> | null = null;
let databaseUnavailable = false;
let rulesCache: ParseRule[] | null = null;
let rulesCacheAt = 0;
const RULE_CACHE_MS = 10_000;

function upsertMemoryOrders(rows: OrderRow[]) {
  for (const row of rows) {
    const index = orders.findIndex((item) => item.id === row.id);
    if (index >= 0) orders[index] = row;
    else orders.unshift(row);
  }
}

type OrderGroup = {
  externalCode: string;
  first: OrderRow;
  items: OrderRow[];
  totalQuantity: number;
};

function groupOrderRows(rows: OrderRow[]): OrderGroup[] {
  const groups = new Map<string, OrderRow[]>();
  for (const row of rows) {
    const key = row.externalCode || row.id;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([externalCode, items]) => ({
    externalCode,
    first: items[0],
    items,
    totalQuantity: items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  }));
}

function filterMemoryOrders(keyword = "") {
  return orders.filter((row) => {
    if (!keyword) return true;
    return [row.externalCode, row.receiverName, row.storeName, row.receiverPhone].some((value) => value.includes(keyword));
  });
}
function markDatabaseUnavailable(error: unknown) {
  databaseUnavailable = true;
  initPromise = null;
  console.warn("Order database unavailable, fallback to memory store:", error instanceof Error ? error.message : error);
}

function isMissingRelation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "42P01";
}


async function ensureRuleTable() {
  if (!pool || databaseUnavailable) return;
  const db = pool;
  ruleInitPromise ??= (async () => {
    await db.sql`
      CREATE TABLE IF NOT EXISTS parse_rules (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  await ruleInitPromise;
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
    await pool.sql`CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC)`;
    await pool.sql`CREATE INDEX IF NOT EXISTS orders_external_code_created_idx ON orders (external_code, created_at DESC)`;
  })();
  await initPromise;
}

export const store = {
  isDatabaseEnabled: () => Boolean(pool) && !databaseUnavailable,
  listRules: async () => {
    if (!pool || databaseUnavailable) return rules;
    if (rulesCache && Date.now() - rulesCacheAt < RULE_CACHE_MS) return rulesCache;
    const db = pool;
    try {
      const result = await db.sql`SELECT payload FROM parse_rules ORDER BY updated_at DESC`;
      rulesCache = result.rows.map((row) => row.payload as ParseRule);
      rulesCacheAt = Date.now();
      return rulesCache;
    } catch (error) {
      if (isMissingRelation(error)) {
        await ensureRuleTable();
        const result = await db.sql`SELECT payload FROM parse_rules ORDER BY updated_at DESC`;
        rulesCache = result.rows.map((row) => row.payload as ParseRule);
        rulesCacheAt = Date.now();
        return rulesCache;
      }
      markDatabaseUnavailable(error);
      return rules;
    }
  },
  saveRule: async (rule: ParseRule) => {
    if (!pool || databaseUnavailable) {
      const index = rules.findIndex((item) => item.id === rule.id);
      if (index >= 0) rules[index] = rule;
      else rules.unshift(rule);
      return rule;
    }
    await ensureRuleTable();
    rulesCache = null;
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
    await ensureRuleTable();
    rulesCache = null;
    await pool.sql`DELETE FROM parse_rules WHERE id = ${id}`;
  },
  listOrders: async (keyword = "") => {
    if (!pool || databaseUnavailable) return filterMemoryOrders(keyword);
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
  listOrderGroups: async (keyword = "", page = 1, pageSize = 10) => {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(50, Math.max(1, Math.floor(pageSize)));
    const offset = (safePage - 1) * safePageSize;
    const memoryGroups = () => {
      const grouped = groupOrderRows(filterMemoryOrders(keyword));
      return {
        groups: grouped.slice(offset, offset + safePageSize),
        total: grouped.length,
        page: safePage,
        pageSize: safePageSize
      };
    };
    if (!pool || databaseUnavailable) return memoryGroups();
    const db = pool;
    const readGroups = async () => {
      const like = `%${keyword}%`;
      const whereSql = keyword
        ? `WHERE external_code ILIKE $1 OR receiver_name ILIKE $1 OR store_name ILIKE $1 OR payload->>'receiverPhone' ILIKE $1`
        : "";
      const queryParams = keyword ? [like, safePageSize, offset] : [safePageSize, offset];
      const limitParam = keyword ? "$2" : "$1";
      const offsetParam = keyword ? "$3" : "$2";
      const result = await db.query(
        `WITH filtered AS (
           SELECT external_code, payload, created_at
           FROM orders
           ${whereSql}
         ), ranked_codes AS (
           SELECT external_code, MAX(created_at) AS latest_at, COUNT(*) OVER()::int AS total
           FROM filtered
           GROUP BY external_code
           ORDER BY latest_at DESC
           LIMIT ${limitParam} OFFSET ${offsetParam}
         )
         SELECT ranked_codes.external_code,
                ranked_codes.total,
                jsonb_agg(filtered.payload ORDER BY filtered.created_at DESC) AS items
         FROM ranked_codes
         JOIN filtered ON filtered.external_code = ranked_codes.external_code
         GROUP BY ranked_codes.external_code, ranked_codes.latest_at, ranked_codes.total
         ORDER BY ranked_codes.latest_at DESC`,
        queryParams
      );
      const groups = result.rows.map((row) => {
        const items = (row.items ?? []) as OrderRow[];
        return {
          externalCode: String(row.external_code),
          first: items[0],
          items,
          totalQuantity: items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
        };
      }).filter((group): group is OrderGroup => Boolean(group.first));
      return {
        groups,
        total: Number(result.rows[0]?.total ?? 0),
        page: safePage,
        pageSize: safePageSize
      };
    };
    try {
      return await readGroups();
    } catch (error) {
      if (isMissingRelation(error)) {
        await ensureTables();
        if (databaseUnavailable) return memoryGroups();
        return await readGroups();
      }
      markDatabaseUnavailable(error);
      return memoryGroups();
    }
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
