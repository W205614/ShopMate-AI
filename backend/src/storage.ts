import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Database } from "../../shared/domain/types";
import type { MemberSummary } from "../../shared/domain/operations";

type RecordValue = Record<string, unknown>;
type StoredRow = { key: string; position: number; data: string };
type Snapshot = {
  loaded: Map<string, unknown>;
  original: Map<string, Map<string, StoredRow>>;
  raw: Map<string, StoredRow[]>;
  scope?: DatabaseReadScope;
  release?: () => void;
};
const snapshots = new WeakMap<Database, Snapshot>();
const readers = new WeakMap<DatabaseSync, Set<WeakRef<Snapshot>>>();
const identifier = /^[a-zA-Z][a-zA-Z0-9]*$/;
export const tableFor = (domain: string) => {
  if (!identifier.test(domain)) throw new Error("Invalid storage domain");
  return `biz_${domain.replace(/[A-Z]/g, (v) => `_${v.toLowerCase()}`)}`;
};
const projections = `
  user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) VIRTUAL,
  order_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.orderId')) VIRTUAL,
  product_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.productId')) VIRTUAL,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) VIRTUAL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) VIRTUAL,
  name TEXT GENERATED ALWAYS AS (json_extract(data,'$.name')) VIRTUAL,
  active INTEGER GENERATED ALWAYS AS (json_extract(data,'$.active')) VIRTUAL,
  category_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.categoryId')) VIRTUAL,
  amount INTEGER GENERATED ALWAYS AS (json_extract(data,'$.amount')) VIRTUAL`;

export function createStorageSchema(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS storage_meta (
    id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL,
    version INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0));
    CREATE TABLE IF NOT EXISTS storage_domains (name TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('array','object','value')));
    CREATE TABLE IF NOT EXISTS product_skus (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES biz_products(key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      price INTEGER NOT NULL CHECK(price>=0 AND typeof(price)='integer'),
      stock INTEGER NOT NULL CHECK(stock>=0 AND typeof(stock)='integer'), data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS product_skus_product ON product_skus(product_id);
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES biz_orders(key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      product_id TEXT NOT NULL, sku_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity>0 AND typeof(quantity)='integer'),
      total INTEGER NOT NULL CHECK(total>=0 AND typeof(total)='integer'),
      refunded_quantity INTEGER NOT NULL CHECK(refunded_quantity>=0 AND refunded_quantity<=quantity),
      data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);`);
  for (const domain of ["categories", "products", "orders"])
    ensureDomain(sql, domain, "array");
  // Tie-breaking keys belong in the index: equal timestamps must not force
  // SQLite to read and sort every historical order before applying LIMIT.
  // Run at startup too, since ensureDomain deliberately skips existing tables.
  sql.exec(`
    CREATE INDEX IF NOT EXISTS biz_orders_owner_page ON biz_orders(user_id,created_at DESC,key DESC);
    CREATE INDEX IF NOT EXISTS biz_orders_status_page ON biz_orders(status,created_at DESC,key DESC);
    CREATE INDEX IF NOT EXISTS biz_orders_time_page ON biz_orders(created_at DESC,key DESC);
    CREATE INDEX IF NOT EXISTS biz_orders_owner_status_page ON biz_orders(user_id,status,created_at DESC,key DESC);
  `);
  for (const domain of [
    "checkoutQuotes",
    "orderRequests",
    "inventoryRequests",
  ]) {
    const table = tableFor(domain);
    if (
      sql
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      ensureCleanupIndex(sql, domain);
  }
}

function ensureCleanupIndex(sql: DatabaseSync, domain: string) {
  const table = tableFor(domain);
  sql.exec(
    domain === "checkoutQuotes"
      ? `CREATE INDEX IF NOT EXISTS ${table}_cleanup ON ${table}(json_extract(data,'$.expiresAt')) WHERE order_id IS NULL`
      : `CREATE INDEX IF NOT EXISTS ${table}_cleanup ON ${table}(created_at)`,
  );
}

function ensureDomain(sql: DatabaseSync, name: string, kind: string) {
  if (sql.prepare("SELECT 1 FROM storage_domains WHERE name=?").get(name))
    return;
  const table = tableFor(name);
  let constraints = "";
  if (name === "orders")
    constraints = `, CHECK(json_extract(data,'$.total')>=0 AND json_type(data,'$.total')='integer'), CHECK(json_extract(data,'$.status') IN ('pending','paid','shipped','completed','cancelled','refunded'))`;
  if (name === "ledger")
    constraints = `, CHECK(amount>=0 AND json_type(data,'$.amount')='integer'), CHECK(json_extract(data,'$.type') IN ('payment','refund','purchase'))`;
  if (["afterSales", "reviews"].includes(name))
    constraints += `, FOREIGN KEY(order_id) REFERENCES biz_orders(key) DEFERRABLE INITIALLY DEFERRED`;
  if (name === "products")
    constraints += `, FOREIGN KEY(category_id) REFERENCES biz_categories(key) DEFERRABLE INITIALLY DEFERRED`;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), ${projections}${constraints});
    CREATE INDEX IF NOT EXISTS ${table}_owner_date ON ${table}(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ${table}_status_date ON ${table}(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS ${table}_position ON ${table}(position);`);
  if (name === "products")
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${table}_catalog ON ${table}(active,category_id);`,
    );
  if (name === "reviews")
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${table}_product ON ${table}(product_id,created_at DESC); CREATE UNIQUE INDEX IF NOT EXISTS ${table}_line ON ${table}(user_id,order_id,json_extract(data,'$.orderItemId'));`,
    );
  if (["orderRequests", "inventoryRequests"].includes(name))
    sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_request ON ${table}(json_extract(data,'$.${name === "orderRequests" ? "userId" : "adminId"}'),json_extract(data,'$.requestId'));`,
    );
  if (["checkoutQuotes", "orderRequests", "inventoryRequests"].includes(name))
    ensureCleanupIndex(sql, name);
  sql
    .prepare("INSERT OR IGNORE INTO storage_domains VALUES (?,?)")
    .run(name, kind);
}

function keyOf(domain: string, value: unknown): string {
  const record = value as RecordValue;
  if (domain === "orderRequests")
    return JSON.stringify([record.userId, record.requestId]);
  if (domain === "inventoryRequests")
    return JSON.stringify([record.adminId, record.requestId]);
  if (typeof record.id !== "string")
    throw new Error(`Missing stable record id in ${domain}`);
  return record.id;
}

function rowsFor(
  domain: string,
  kind: string,
  value: unknown,
  old: Map<string, StoredRow>,
): Map<string, StoredRow> {
  const entries =
    kind === "array"
      ? (value as unknown[]).map((v, i) => [keyOf(domain, v), i, v] as const)
      : kind === "object"
        ? Object.entries(value as RecordValue).map(
            ([key, v], i) => [key, i, v] as const,
          )
        : [["singleton", 0, value] as const];
  const rows = new Map<string, StoredRow>();
  const nextPositions: (number | undefined)[] = [];
  let nextExisting: number | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    nextPositions[i] = nextExisting;
    nextExisting = old.get(entries[i][0])?.position ?? nextExisting;
  }
  let previous = -Infinity;
  for (const [index, [key, , item]] of entries.entries()) {
    if (rows.has(key))
      throw new Error(`Duplicate stable record id in ${domain}`);
    let position = old.get(key)?.position;
    if (position === undefined || position <= previous) {
      const candidate = nextPositions[index],
        next =
          candidate !== undefined && candidate > previous
            ? candidate
            : undefined;
      position =
        next !== undefined
          ? Number.isFinite(previous)
            ? (previous + next) / 2
            : next - 1
          : Number.isFinite(previous)
            ? previous + 1
            : 0;
    }
    previous = position;
    rows.set(key, { key, position, data: JSON.stringify(item) });
  }
  return rows;
}

function projectChildren(sql: DatabaseSync, domain: string, row: StoredRow) {
  if (domain !== "products" && domain !== "orders") return;
  const record = JSON.parse(row.data),
    product = domain === "products";
  const table = product ? "product_skus" : "order_items",
    parent = product ? "product_id" : "order_id";
  const children = (product ? record.skus : record.items) as RecordValue[];
  const old = new Map(
    (
      sql
        .prepare(`SELECT id,data FROM ${table} WHERE ${parent}=?`)
        .all(row.key) as { id: string; data: string }[]
    ).map((v) => [v.id, v.data]),
  );
  const keep = new Set<string>();
  for (const child of children) {
    const id = child.id as string,
      data = JSON.stringify(child);
    if (keep.has(id)) throw new Error("Duplicate child identity");
    const existing = sql
      .prepare(`SELECT ${parent} AS parent FROM ${table} WHERE id=?`)
      .get(id) as { parent: string } | undefined;
    if (existing && existing.parent !== row.key)
      throw new Error("Duplicate child identity across parent records");
    keep.add(id);
    if (old.get(id) === data) continue;
    if (product)
      sql
        .prepare(
          `INSERT INTO product_skus(id,product_id,price,stock,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,price=excluded.price,stock=excluded.stock,data=excluded.data`,
        )
        .run(id, row.key, child.price as number, child.stock as number, data);
    else
      sql
        .prepare(
          `INSERT INTO order_items(id,order_id,product_id,sku_id,quantity,total,refunded_quantity,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET order_id=excluded.order_id,product_id=excluded.product_id,sku_id=excluded.sku_id,quantity=excluded.quantity,total=excluded.total,refunded_quantity=excluded.refunded_quantity,data=excluded.data`,
        )
        .run(
          id,
          row.key,
          child.productId as string,
          child.skuId as string,
          child.quantity as number,
          child.total as number,
          child.refundedQuantity as number,
          data,
        );
  }
  for (const id of old.keys())
    if (!keep.has(id)) sql.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
}

export interface DatabaseReadScope {
  userId?: string;
  orderIds?: string[];
  pendingOnly?: boolean;
  /** Domains are complete only inside these selectors. Omitted rows are never deleted. */
  domains?: Partial<
    Record<
      keyof Database,
      {
        userId?: string;
        keys?: string[];
        appendOnly?: "prepend" | "append";
        expiredBefore?: string;
      }
    >
  >;
}
function orderScope(scope: DatabaseReadScope) {
  const clauses = ["status='pending'"],
    args: SQLInputValue[] = [];
  if (scope.userId) {
    clauses.push("user_id=?");
    args.push(scope.userId);
  }
  if (scope.orderIds?.length) {
    clauses.push(`key IN (${scope.orderIds.map(() => "?").join(",")})`);
    args.push(...scope.orderIds);
  }
  return { where: clauses.join(" OR "), args };
}
function readRows(sql: DatabaseSync, name: string, scope?: DatabaseReadScope) {
  const domain = scope?.domains?.[name as keyof Database];
  if (domain) {
    const clauses: string[] = [],
      args: SQLInputValue[] = [];
    if (domain.appendOnly) return [];
    if (domain.userId !== undefined) {
      clauses.push("user_id=?");
      args.push(domain.userId);
    }
    if (domain.keys) {
      clauses.push(
        domain.keys.length
          ? `key IN (${domain.keys.map(() => "?").join(",")})`
          : "0",
      );
      args.push(...domain.keys);
    }
    if (domain.expiredBefore) {
      clauses.push(
        name === "checkoutQuotes"
          ? "order_id IS NULL AND json_extract(data,'$.expiresAt')<=?"
          : "created_at<=?",
      );
      args.push(domain.expiredBefore);
    }
    return sql
      .prepare(
        `SELECT key,position,data FROM ${tableFor(name)} WHERE ${clauses.join(" AND ") || "1"} ORDER BY position`,
      )
      .all(...args) as StoredRow[];
  }
  const subset =
    scope && (name === "orders" || name === "afterSales")
      ? orderScope(scope)
      : undefined;
  const where = subset
    ? name === "orders"
      ? `WHERE (${subset.where})`
      : `WHERE order_id IN (SELECT key FROM biz_orders WHERE ${subset.where})`
    : "";
  return sql
    .prepare(
      `SELECT key,position,data FROM ${tableFor(name)} ${where} ORDER BY position`,
    )
    .all(...(subset?.args ?? [])) as StoredRow[];
}
function preserveReaders(sql: DatabaseSync, name: string, writer?: Snapshot) {
  const references = readers.get(sql);
  if (!references) return;
  const rows = new Map<string, StoredRow[]>();
  for (const reference of references) {
    const reader = reference.deref();
    if (!reader) {
      references.delete(reference);
      continue;
    }
    if (reader === writer || reader.loaded.has(name) || reader.raw.has(name))
      continue;
    const scopeKey = JSON.stringify(reader.scope ?? {});
    if (!rows.has(scopeKey))
      rows.set(scopeKey, readRows(sql, name, reader.scope));
    reader.raw.set(name, rows.get(scopeKey)!);
  }
}
export function preserveBeforeClose(sql: DatabaseSync) {
  for (const { name } of sql
    .prepare("SELECT name FROM storage_domains")
    .all() as { name: string }[])
    preserveReaders(sql, name);
}

/** Single-record insert for durable deliveries; caller owns the enclosing transaction. */
export function insertStoredRecord<T extends { id: string }>(
  sql: DatabaseSync,
  domain: keyof Database,
  record: T,
  atFront = false,
) {
  if (!sql.isTransaction) throw new Error("RECORD_INSERT_REQUIRES_TRANSACTION");
  ensureDomain(sql, domain, "array");
  const table = tableFor(domain);
  if (sql.prepare(`SELECT 1 FROM ${table} WHERE key=?`).get(record.id))
    return false;
  preserveReaders(sql, domain);
  const position = sql
    .prepare(
      `SELECT coalesce(${atFront ? "min" : "max"}(position),${atFront ? 1 : -1}) ${atFront ? "-" : "+"} 1 AS n FROM ${table}`,
    )
    .get()!.n as number;
  sql
    .prepare(`INSERT INTO ${table}(key,position,data) VALUES(?,?,?)`)
    .run(record.id, position, JSON.stringify(record));
  sql.prepare("UPDATE storage_meta SET revision=revision+1 WHERE id=1").run();
  return true;
}
export function loadStoredDatabase(
  sql: DatabaseSync,
  scope?: DatabaseReadScope,
): Database {
  // Lazy reads and later writes must share the range captured at creation time.
  // Do not retain caller-owned selectors or key arrays that can subsequently change.
  const readScope = scope === undefined ? undefined : structuredClone(scope);
  const meta = sql
    .prepare("SELECT version,revision FROM storage_meta WHERE id=1")
    .get() as { version: number; revision: number };
  const db = { ...meta } as Database;
  const state: Snapshot = {
    loaded: new Map(),
    original: new Map(),
    raw: new Map(),
    scope: readScope,
  };
  snapshots.set(db, state);
  if (!readers.has(sql)) readers.set(sql, new Set());
  const reference = new WeakRef(state);
  readers.get(sql)!.add(reference);
  state.release = () => readers.get(sql)?.delete(reference);
  for (const { name, kind } of sql
    .prepare("SELECT name,kind FROM storage_domains")
    .all() as { name: string; kind: string }[]) {
    Object.defineProperty(db, name, {
      enumerable: true,
      configurable: true,
      get() {
        if (!state.loaded.has(name)) {
          const rows = state.raw.get(name) ?? readRows(sql, name, readScope);
          state.raw.delete(name);
          state.original.set(name, new Map(rows.map((r) => [r.key, r])));
          state.loaded.set(
            name,
            kind === "array"
              ? rows.map((r) => JSON.parse(r.data))
              : kind === "object"
                ? Object.fromEntries(
                    rows.map((r) => [r.key, JSON.parse(r.data)]),
                  )
                : JSON.parse(rows[0]?.data ?? "null"),
          );
        }
        return state.loaded.get(name);
      },
      set(value) {
        if (!state.original.has(name))
          void (db as unknown as RecordValue)[name];
        state.loaded.set(name, value);
      },
    });
  }
  return db;
}

/** End a transient snapshot's lifetime; it must not be used for future lazy reads. */
export function releaseSnapshot(db: Database) {
  snapshots.get(db)?.release?.();
}

export function saveStoredDatabase(sql: DatabaseSync, db: Database) {
  const snapshot = snapshots.get(db);
  const values = db as unknown as RecordValue;
  const domains = snapshot
    ? [
        ...new Set([
          ...snapshot.loaded.keys(),
          ...Object.keys(db).filter(
            (name) =>
              !Object.getOwnPropertyDescriptor(db, name)?.get &&
              name !== "version" &&
              name !== "revision",
          ),
        ]),
      ]
    : Object.keys(db).filter(
        (name) => name !== "version" && name !== "revision",
      );
  for (const name of domains) {
    const value = values[name];
    if (value !== undefined)
      ensureDomain(
        sql,
        name,
        Array.isArray(value)
          ? "array"
          : name === "favorites"
            ? "object"
            : "value",
      );
  }
  for (const name of domains) {
    const value = values[name];
    if (value === undefined) continue;
    const kind = Array.isArray(value)
      ? "array"
      : name === "favorites"
        ? "object"
        : "value";
    ensureDomain(sql, name, kind);
    const table = tableFor(name);
    const old =
      snapshot?.original.get(name) ??
      new Map(
        (
          sql
            .prepare(`SELECT key,position,data FROM ${table}`)
            .all() as StoredRow[]
        ).map((r) => [r.key, r]),
      );
    const domainScope = snapshot?.scope?.domains?.[name as keyof Database];
    const partial =
      !!domainScope ||
      (!!snapshot?.scope && ["orders", "afterSales"].includes(name));
    const rows = rowsFor(name, kind, value, old);
    if (partial) {
      // Never let a new row in a partial snapshot overwrite an excluded record.
      let before = Number(
          sql
            .prepare(`SELECT position FROM ${table} ORDER BY position LIMIT 1`)
            .get()?.position ?? 0,
        ),
        after = Number(
          sql
            .prepare(
              `SELECT position FROM ${table} ORDER BY position DESC LIMIT 1`,
            )
            .get()?.position ?? -1,
        );
      const fresh = [...rows.values()].filter((row) => !old.has(row.key));
      const prepend =
        domainScope?.appendOnly === "prepend" ||
        ["orders", "afterSales"].includes(name) ||
        (fresh.length > 0 &&
          [...rows.keys()].indexOf(fresh[0]!.key) === 0 &&
          old.size > 0);
      if (prepend) before -= fresh.length;
      for (const row of rows.values()) {
        const item = JSON.parse(row.data);
        if (
          domainScope?.userId !== undefined &&
          item.userId !== domainScope.userId
        )
          throw new Error("SCOPED_OWNER_MISMATCH");
        if (old.has(row.key)) continue;
        if (sql.prepare(`SELECT 1 FROM ${table} WHERE key=?`).get(row.key))
          throw new Error("SCOPED_RECORD_COLLISION");
        row.position = prepend ? before++ : ++after;
      }
    }
    const changed =
      rows.size !== old.size ||
      [...rows].some(
        ([key, row]) =>
          old.get(key)?.data !== row.data ||
          old.get(key)?.position !== row.position,
      );
    if (changed) {
      preserveReaders(sql, name, snapshot);
      // An order transition changes which after-sales belong to a pending-only snapshot.
      if (
        name === "orders" &&
        sql
          .prepare("SELECT 1 FROM storage_domains WHERE name='afterSales'")
          .get()
      )
        preserveReaders(sql, "afterSales", snapshot);
    }
    const upsert = sql.prepare(
      `INSERT INTO ${table}(key,position,data) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET position=excluded.position,data=excluded.data`,
    );
    for (const row of rows.values()) {
      const previous = old.get(row.key);
      if (previous?.data !== row.data || previous?.position !== row.position) {
        upsert.run(row.key, row.position, row.data);
        if (previous?.data !== row.data) projectChildren(sql, name, row);
      }
    }
    for (const key of old.keys())
      if (!rows.has(key))
        sql.prepare(`DELETE FROM ${table} WHERE key=?`).run(key);
    snapshot?.original.set(name, rows);
  }
  sql
    .prepare(
      `INSERT INTO storage_meta VALUES(1,1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,revision=excluded.revision`,
    )
    .run(db.version, db.revision);
}

export interface PageOptions {
  page?: number;
  pageSize?: number;
  userId?: string;
  status?: string;
  productId?: string;
  categoryId?: string;
  active?: boolean;
  search?: string;
  ids?: string[];
  orderId?: string;
  min?: number;
  max?: number;
  inStock?: boolean;
  type?: string;
  from?: string;
  to?: string;
  favoriteUserId?: string;
  locateId?: string;
  claimEndsAfter?: string;
  sort?:
    | "newest"
    | "oldest"
    | "position"
    | "price-asc"
    | "price-desc"
    | "priceAsc"
    | "priceDesc"
    | "sales"
    | "featured"
    | "asc"
    | "desc";
}
export function queryPage<T>(
  sql: DatabaseSync,
  domain: keyof Database,
  options: PageOptions = {},
) {
  const table = tableFor(domain);
  if (
    !sql
      .prepare("SELECT 1 FROM storage_domains WHERE name=? AND kind='array'")
      .get(domain)
  )
    throw new Error("Unknown list domain");
  const page = Math.max(1, Math.trunc(options.page ?? 1)),
    pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 20)));
  const filters: string[] = [],
    args: SQLInputValue[] = [];
  for (const [key, column] of [
    ["userId", "user_id"],
    ["status", "status"],
    ["productId", "product_id"],
    ["categoryId", "category_id"],
    ["orderId", "order_id"],
  ] as const)
    if (options[key] !== undefined) {
      const reviewState = `CASE WHEN json_extract(data,'$.deleted')=1 THEN 'deleted' WHEN NOT EXISTS(SELECT 1 FROM order_items i JOIN biz_orders o ON o.key=i.order_id WHERE i.id=json_extract(${table}.data,'$.orderItemId') AND i.product_id=${table}.product_id AND o.user_id=${table}.user_id) THEN 'history' WHEN (SELECT i.refunded_quantity>=i.quantity FROM order_items i WHERE i.id=json_extract(${table}.data,'$.orderItemId')) THEN 'refunded' WHEN json_extract(data,'$.hidden')=1 THEN 'hidden' ELSE 'visible' END`;
      filters.push(
        `${domain === "reviews" && key === "status" ? `(${reviewState})` : column}=?`,
      );
      args.push(options[key]!);
    }
  if (options.ids) {
    filters.push(
      options.ids.length
        ? `key IN (${options.ids.map(() => "?").join(",")})`
        : "0",
    );
    args.push(...options.ids);
  }
  if (options.favoriteUserId !== undefined) {
    filters.push(
      "key IN (SELECT value FROM json_each((SELECT data FROM biz_favorites WHERE key=?)))",
    );
    args.push(options.favoriteUserId);
  }
  if (options.active !== undefined) {
    filters.push("active=?");
    args.push(Number(options.active));
  }
  if (domain === "coupons" && options.claimEndsAfter !== undefined) {
    filters.push("julianday(json_extract(data,'$.claimEndsAt'))>julianday(?)");
    args.push(options.claimEndsAfter);
  }
  if (options.search) {
    if (domain === "products") {
      sql.function("normalize_search", { deterministic: true }, (value) =>
        String(value ?? "")
          .normalize("NFKC")
          .toLowerCase(),
      );
      const text = `normalize_search(coalesce(name,'')||' '||coalesce(json_extract(data,'$.subtitle'),'')||' '||coalesce(json_extract(data,'$.description'),'')||' '||coalesce(json_extract(data,'$.material'),'')||' '||coalesce((SELECT json_extract(c.data,'$.name') FROM biz_categories c WHERE c.key=${table}.category_id),'')||' '||coalesce((SELECT group_concat(json_extract(s.data,'$.name'),' ') FROM product_skus s WHERE s.product_id=${table}.key),''))`;
      for (const word of options.search
        .normalize("NFKC")
        .toLowerCase()
        .split(/[\s，、,]+/)
        .filter(Boolean)) {
        filters.push(`instr(${text},?)>0`);
        args.push(word);
      }
    } else {
      const paths: Partial<Record<keyof Database, string[]>> = {
        categories: ["name", "description"],
        ledger: ["reference", "note", "inventoryMovementId"],
        faqs: ["question", "answer"],
        orders: ["address.name"],
        inventory: ["productId", "skuId", "reason"],
        reviews: ["content"],
        conversations: ["title", "orderId"],
      };
      const extras = (paths[domain] ?? ["name", "title"]).map(
        (path) => `coalesce(json_extract(data,'$.${path}'),'')`,
      );
      if (["inventory", "reviews"].includes(domain))
        extras.push(
          `coalesce((SELECT p.name FROM biz_products p WHERE p.key=${table}.product_id),'')`,
        );
      if (domain === "inventory")
        extras.push(
          `coalesce((SELECT json_extract(s.data,'$.name') FROM product_skus s WHERE s.id=json_extract(${table}.data,'$.skuId')),'')`,
        );
      if (domain === "orders")
        extras.push(
          "coalesce((SELECT group_concat(coalesce(json_extract(i.value,'$.name'),'')||' '||coalesce(json_extract(i.value,'$.skuName'),''),' ') FROM json_each(data,'$.items') i),'')",
        );
      if (domain === "faqs")
        extras.push(
          "coalesce((SELECT group_concat(value,' ') FROM json_each(data,'$.keywords')),'')",
        );
      if (domain === "conversations")
        extras.push(
          `coalesce((SELECT u.name FROM biz_users u WHERE u.key=${table}.user_id),'')`,
        );
      filters.push(
        `instr(lower(key||' '||coalesce(order_id,'')||' '||${extras.join("||' '||")}),lower(?))>0`,
      );
      args.push(options.search);
    }
  }
  if (options.type !== undefined) {
    filters.push("json_extract(data,'$.type')=?");
    args.push(options.type);
  }
  if (options.from !== undefined) {
    filters.push("date(created_at,'+8 hours')>=?");
    args.push(options.from);
  }
  if (options.to !== undefined) {
    filters.push("date(created_at,'+8 hours')<=?");
    args.push(options.to);
  }
  if (domain === "products") {
    for (const [value, operator] of [
      [options.min, ">="],
      [options.max, "<="],
    ] as const)
      if (value !== undefined) {
        filters.push(
          `(SELECT min(price) FROM product_skus WHERE product_id=${table}.key) ${operator} ?`,
        );
        args.push(value);
      }
    if (options.inStock) {
      filters.push(
        `EXISTS(SELECT 1 FROM product_skus s WHERE s.product_id=${table}.key AND s.stock > (SELECT coalesce(sum(i.quantity),0) FROM order_items i JOIN biz_orders o ON o.key=i.order_id WHERE i.sku_id=s.id AND o.status='pending' AND json_extract(o.data,'$.inventoryPolicy')='reserved-v1' AND json_extract(o.data,'$.expiresAt')>?))`,
      );
      args.push(new Date().toISOString());
    }
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const total = Number(
    (
      sql
        .prepare(`SELECT count(*) AS total FROM ${table} ${where}`)
        .get(...args) as { total: number }
    ).total,
  );
  const order =
    domain === "conversations" && (!options.sort || options.sort === "newest")
      ? "CASE status WHEN 'waiting' THEN 0 WHEN 'human' THEN 1 WHEN 'bot' THEN 2 WHEN 'closed' THEN 3 ELSE 4 END,created_at DESC,key DESC"
      : ["asc", "desc"].includes(options.sort ?? "")
        ? `${domain === "products" ? `(SELECT min(price) FROM product_skus WHERE product_id=${table}.key)` : domain === "categories" ? "json_extract(data,'$.sort')" : domain === "ledger" ? "amount" : domain === "inventory" ? "json_extract(data,'$.delta')" : "created_at"} ${options.sort === "asc" ? "ASC" : "DESC"},key ASC`
        : options.sort === "oldest"
          ? "created_at ASC,key ASC"
          : options.sort === "position"
            ? "position ASC,key ASC"
            : domain === "products" &&
                ["priceAsc", "price-asc", "priceDesc", "price-desc"].includes(
                  options.sort ?? "",
                )
              ? `(SELECT min(price) FROM product_skus WHERE product_id=${table}.key) ${["priceAsc", "price-asc"].includes(options.sort!) ? "ASC" : "DESC"},key ASC`
              : domain === "products" && options.sort === "featured"
                ? "json_extract(data,'$.featured') DESC,position ASC,key ASC"
                : domain === "products" && options.sort === "sales"
                  ? `(SELECT coalesce(sum(i.quantity-i.refunded_quantity),0) FROM order_items i JOIN biz_orders o ON o.key=i.order_id WHERE i.product_id=${table}.key AND o.status IN ('paid','shipped','completed')) DESC,key ASC`
                  : "created_at DESC,key DESC";
  const pages = Math.max(1, Math.ceil(total / pageSize));
  let actualPage = Math.min(page, pages),
    located: boolean | undefined;
  if (domain === "conversations" && options.locateId !== undefined) {
    const rank = sql
      .prepare(
        `SELECT ordinal FROM (SELECT key,row_number() OVER (ORDER BY ${order}) AS ordinal FROM ${table} ${where}) WHERE key=?`,
      )
      .get(...args, options.locateId) as { ordinal: number } | undefined;
    located = !!rank;
    if (rank) actualPage = Math.floor((rank.ordinal - 1) / pageSize) + 1;
  }
  const items = (
    sql
      .prepare(
        `SELECT data FROM ${table} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (actualPage - 1) * pageSize) as { data: string }[]
  ).map((row) => JSON.parse(row.data) as T);
  let totals:
    | { payment: string; refund: string; purchase: string; net: string }
    | undefined;
  if (domain === "ledger") {
    const amounts = { payment: 0n, refund: 0n, purchase: 0n };
    const statement = sql.prepare(
      `SELECT json_extract(data,'$.type') AS type,amount FROM ${table} ${where}`,
    );
    statement.setReadBigInts(true);
    for (const row of statement.iterate(...args) as Iterable<{
      type: keyof typeof amounts;
      amount: bigint;
    }>)
      amounts[row.type] += row.amount;
    totals = {
      payment: String(amounts.payment),
      refund: String(amounts.refund),
      purchase: String(amounts.purchase),
      net: String(amounts.payment - amounts.refund - amounts.purchase),
    };
  }
  return {
    items,
    total,
    page: actualPage,
    pageSize,
    pages,
    totals,
    located,
  };
}
export function readMetadata(sql: DatabaseSync) {
  return sql
    .prepare("SELECT version,revision FROM storage_meta WHERE id=1")
    .get() as { version: number; revision: number };
}
export function queryMemberSummary(
  sql: DatabaseSync,
  userId: string,
): MemberSummary {
  const count = (domain: string) =>
    Number(
      (
        sql
          .prepare(
            `SELECT count(*) AS total FROM ${tableFor(domain)} WHERE user_id=?`,
          )
          .get(userId) as { total: number }
      ).total,
    );
  return {
    orderCount: count("orders"),
    afterSaleCount: count("afterSales"),
    couponClaimCount: count("couponClaims"),
    favoriteCount: Number(
      (
        sql
          .prepare(
            "SELECT json_array_length(data) AS total FROM biz_favorites WHERE key=?",
          )
          .get(userId) as { total: number } | undefined
      )?.total ?? 0,
    ),
    cartQuantity: Number(
      (
        sql
          .prepare(
            "SELECT coalesce(sum(json_extract(data,'$.quantity')),0) AS total FROM biz_carts WHERE user_id=?",
          )
          .get(userId) as { total: number }
      ).total,
    ),
  };
}
export function queryRecord<T>(
  sql: DatabaseSync,
  domain: keyof Database,
  key: string,
): T | undefined {
  const row = sql
    .prepare(`SELECT data FROM ${tableFor(domain)} WHERE key=?`)
    .get(key) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}
