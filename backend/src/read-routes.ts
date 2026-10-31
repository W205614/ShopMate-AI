import { dashboard } from "./dashboard";
import type { Express, Request } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  Database,
  Product,
  Order,
  AfterSale,
  Session,
  CartItem,
} from "../../shared/domain/types";
import { readDatabase, queryPage, queryRecord, tableFor } from "./database";
import { findSession, HttpError } from "./auth";
import { collectionPermission, demand, permits } from "./permissions";
import { availableStock, reservedStock } from "./commerce-rules";
import { createReconciliationReader } from "./reconciliation-reader";
import type { Promotion, PurchaseOrder } from "../../shared/domain/operations";
import { queryMemberSummary, type PageOptions } from "./storage";
import { stockAvailabilityFrom, availableStockSql } from "./stock-availability";
import { releaseSnapshot } from "./storage";

const meta = (sql: DatabaseSync) =>
  sql.prepare("SELECT version,revision FROM storage_meta WHERE id=1").get() as {
    version: number;
    revision: number;
  };
const empty = (sql: DatabaseSync): Database => ({
  ...meta(sql),
  users: [],
  categories: [],
  products: [],
  carts: [],
  addresses: [],
  favorites: {},
  orders: [],
  afterSales: [],
  inventory: [],
  ledger: [],
  conversations: [],
  faqs: [],
  settings: { name: "", slogan: "", notice: "" },
  coupons: [],
  couponClaims: [],
  reviews: [],
  checkoutQuotes: [],
  orderRequests: [],
  inventoryRequests: [],
  shippingRules: [],
  promotions: [],
  pointsEntries: [],
  suppliers: [],
  purchaseOrders: [],
  returnInspections: [],
  notifications: [],
  auditEntries: [],
});
const pageNumber = z.coerce.number().int().min(1).max(1_000_000);
const pageSize = z.coerce.number().int().min(1).max(100);
const privateCollections = new Set([
  "users",
  "carts",
  "addresses",
  "orders",
  "afterSales",
  "conversations",
  "couponClaims",
  "reviews",
  "checkoutQuotes",
  "orderRequests",
  "pointsEntries",
  "notifications",
]);
const publicCollections = new Set([
  "products",
  "categories",
  "coupons",
  "faqs",
  "promotions",
]);
const hiddenCollections = new Set([
  "inventoryRequests",
  "orderRequests",
  "checkoutQuotes",
]);
function signed(sql: DatabaseSync, req: Request, role: "user" | "admin") {
  const session = findSession(sql, req, role);
  if (!session) throw new HttpError(401, "登录已失效，请重新登录");
  return session;
}
function projectedProducts(
  sql: DatabaseSync,
  products: Product[],
  warehouse = false,
) {
  const db = readDatabase(sql, { pendingOnly: true });
  try {
    return products.map((p) => ({
      ...p,
      skus: p.skus.map((s) => ({
        ...s,
        stock: warehouse ? s.stock : availableStock(db, p.id, s.id),
        reserved: reservedStock(db, p.id, s.id),
      })),
    }));
  } finally {
    releaseSnapshot(db);
  }
}
/** Related review/claim context carries eligibility only when this employee cannot read orders. */
function orderEligibility(order: Order): Order {
  return {
    id: order.id,
    userId: order.userId,
    status: order.status,
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      refundedQuantity: item.refundedQuantity,
    })),
  } as Order;
}
function relatedRecords(
  sql: DatabaseSync,
  collection: string,
  items: unknown[],
  session: Session | null,
  role: "user" | "admin",
): Partial<Database> {
  const related: Partial<Database> = {},
    productIds = new Set<string>(),
    orderIds = new Set<string>();
  if (collection === "couponClaims") {
    const couponIds = new Set(
      (items as Database["couponClaims"]).map((c) => c.couponId),
    );
    related.coupons = [...couponIds]
      .map((key) =>
        queryRecord<Database["coupons"][number]>(sql, "coupons", key),
      )
      .filter((c): c is Database["coupons"][number] => !!c);
  }
  if (collection === "coupons" && role === "user" && session && items.length) {
    const ids = (items as Database["coupons"]).map((c) => c.id);
    related.couponClaims = (
      sql
        .prepare(
          `SELECT data FROM biz_coupon_claims WHERE user_id=? AND json_extract(data,'$.couponId') IN (${ids.map(() => "?").join(",")})`,
        )
        .all(session.id, ...ids) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  if (collection === "ledger" && role === "admin") {
    const entries = items as Database["ledger"];
    if (
      collectionPermission("orders").some((permission) =>
        permits(session, permission),
      )
    ) {
      for (const entry of entries)
        if (entry.type === "payment" || entry.type === "refund")
          orderIds.add(entry.reference);
    }
    if (
      collectionPermission("inventory").some((permission) =>
        permits(session, permission),
      )
    ) {
      const movementIds = new Set(
        entries
          .map((entry) => entry.inventoryMovementId)
          .filter((id): id is string => !!id),
      );
      related.inventory = [...movementIds]
        .map((id) =>
          queryRecord<Database["inventory"][number]>(sql, "inventory", id),
        )
        .filter(
          (movement): movement is Database["inventory"][number] => !!movement,
        );
      for (const movement of related.inventory)
        productIds.add(movement.productId);
      if (
        collectionPermission("purchaseOrders").some((permission) =>
          permits(session, permission),
        )
      ) {
        const realMovementIds = new Set(
            related.inventory.map((movement) => movement.id),
          ),
          purchases = new Map<string, PurchaseOrder>();
        const matchingPurchase =
          sql.prepare(`SELECT p.data FROM biz_purchase_orders p WHERE EXISTS(
          SELECT 1 FROM json_each(p.data,'$.receipts') receipt WHERE json_extract(receipt.value,'$.id')=?
          AND EXISTS(SELECT 1 FROM json_each(receipt.value,'$.movementIds') movement WHERE movement.value=?))`);
        for (const entry of entries) {
          if (
            entry.type !== "purchase" ||
            !entry.inventoryMovementId ||
            !realMovementIds.has(entry.inventoryMovementId)
          )
            continue;
          for (const row of matchingPurchase.all(
            entry.reference,
            entry.inventoryMovementId,
          ) as { data: string }[]) {
            const purchase = JSON.parse(row.data) as PurchaseOrder;
            purchases.set(purchase.id, purchase);
          }
        }
        related.purchaseOrders = [...purchases.values()];
        for (const purchase of related.purchaseOrders)
          for (const line of purchase.lines) productIds.add(line.productId);
      }
    }
  }
  for (const value of items) {
    const row = value as Record<string, unknown>;
    if (row.productId) productIds.add(String(row.productId));
    if (row.orderId) orderIds.add(String(row.orderId));
    for (const line of (row.items ?? row.lines ?? []) as {
      productId?: string;
    }[])
      if (line.productId) productIds.add(line.productId);
    if (collection === "conversations" && Array.isArray(row.messages)) {
      for (const value of row.messages) {
        if (!value || typeof value !== "object") continue;
        const message = value as { productIds?: unknown; orderId?: unknown };
        if (typeof message.orderId === "string") orderIds.add(message.orderId);
        if (Array.isArray(message.productIds))
          for (const productId of message.productIds)
            if (typeof productId === "string") productIds.add(productId);
      }
    }
  }
  if (collection === "orders") {
    const ids = (items as Order[]).map((order) => order.id);
    if (ids.length)
      related.afterSales = (
        sql
          .prepare(
            `SELECT data FROM biz_after_sales WHERE order_id IN (${ids.map(() => "?").join(",")}) ${role === "user" ? "AND user_id=?" : ""}`,
          )
          .all(...ids, ...(role === "user" ? [session!.id] : [])) as {
          data: string;
        }[]
      ).map((row) => JSON.parse(row.data) as AfterSale);
    if (
      ids.length &&
      (role === "user" ||
        collectionPermission("reviews").some((permission) =>
          permits(session, permission),
        ))
    ) {
      related.reviews = (
        sql
          .prepare(
            `SELECT data FROM biz_reviews WHERE order_id IN (${ids.map(() => "?").join(",")}) ${role === "user" ? "AND user_id=?" : ""}`,
          )
          .all(...ids, ...(role === "user" ? [session!.id] : [])) as {
          data: string;
        }[]
      ).map((row) => JSON.parse(row.data));
    }
  }
  if (orderIds.size)
    related.orders = [...orderIds]
      .slice(0, 100)
      .map((key) => queryRecord<Order>(sql, "orders", key))
      .filter(
        (o): o is Order =>
          !!o && (role === "admin" || o.userId === session?.id),
      )
      .map((order) =>
        role === "admin" &&
        !collectionPermission("orders").some((permission) =>
          permits(session, permission),
        )
          ? orderEligibility(order)
          : order,
      );
  for (const order of related.orders ?? [])
    for (const item of order.items) productIds.add(item.productId);
  if (productIds.size)
    related.products = projectedProducts(
      sql,
      [...productIds]
        .slice(0, 100)
        .map((key) => queryRecord<Product>(sql, "products", key))
        .filter((p): p is Product => !!p),
      role === "admin",
    );
  if (
    role === "admin" &&
    session &&
    collectionPermission(collection).some((p) => permits(session, p))
  ) {
    const ids = new Set(
      (items as { userId?: string }[]).map((r) => r.userId).filter(Boolean),
    );
    related.users = [...ids]
      .slice(0, 100)
      .map((key) => queryRecord<Database["users"][number]>(sql, "users", key!))
      .filter((u): u is Database["users"][number] => !!u);
  }
  return related;
}
/** Warehouse rows are SKUs, so page SKUs before grouping them back into product snapshots. */
function stockPage(sql: DatabaseSync, req: Request, options: PageOptions) {
  const where: string[] = [],
    args: (string | number)[] = [new Date().toISOString()];
  if (options.search) {
    where.push(
      "instr(lower(p.key||' '||s.id||' '||p.name||' '||json_extract(s.data,'$.name')),lower(?))>0",
    );
    args.push(options.search);
  }
  if (req.query.low === "1") where.push(`${availableStockSql}<=5`);
  if (options.ids) {
    where.push(
      options.ids.length
        ? `p.key IN (${options.ids.map(() => "?").join(",")})`
        : "0",
    );
    args.push(...options.ids);
  }
  const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    sql
      .prepare(`SELECT count(*) AS total ${stockAvailabilityFrom} ${predicate}`)
      .get(...args) as { total: number }
  ).total;
  const pageSize = options.pageSize ?? 10,
    pages = Math.max(1, Math.ceil(total / pageSize)),
    page = Math.min(options.page ?? 1, pages);
  const sort =
    options.sort === "asc" || options.sort === "desc"
      ? `${availableStockSql} ${options.sort === "asc" ? "ASC" : "DESC"},p.position,s.id`
      : "p.position,s.id";
  const rows = sql
    .prepare(
      `SELECT p.data AS product,s.data AS sku ${stockAvailabilityFrom} ${predicate} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize) as {
    product: string;
    sku: string;
  }[];
  const products = new Map<string, Product>();
  for (const row of rows) {
    const product = JSON.parse(row.product) as Product;
    if (!products.has(product.id))
      products.set(product.id, { ...product, skus: [] });
    products
      .get(product.id)!
      .skus.push(JSON.parse(row.sku) as Product["skus"][number]);
  }
  return {
    items: [...products.values()] as unknown[],
    total,
    page,
    pageSize,
    pages,
  };
}
export function registerReadRoutes(app: Express, sql: DatabaseSync) {
  app.get("/api/bootstrap", (req, res) => {
    const sessions = {
        user: findSession(sql, req, "user"),
        admin: findSession(sql, req, "admin"),
      },
      db = empty(sql);
    db.categories = queryPage<Database["categories"][number]>(
      sql,
      "categories",
      { pageSize: 100, sort: "position" },
    ).items;
    db.categories = db.categories.map((c) => ({
      ...c,
      productCount: (
        sql
          .prepare(
            "SELECT count(*) AS n FROM biz_products WHERE category_id=? AND active=1",
          )
          .get(c.id) as { n: number }
      ).n,
    }));
    db.products = projectedProducts(
      sql,
      queryPage<Product>(sql, "products", {
        pageSize: 24,
        active: true,
        sort: "position",
      }).items,
    );
    db.faqs = queryPage<Database["faqs"][number]>(sql, "faqs", {
      pageSize: 100,
      active: true,
    }).items;
    db.settings = queryRecord(sql, "settings", "singleton") ?? db.settings;
    db.coupons = queryPage<Database["coupons"][number]>(sql, "coupons", {
      pageSize: 100,
    }).items;
    db.promotions = queryPage<Promotion>(sql, "promotions", {
      pageSize: 100,
      active: true,
    }).items;
    if (sessions.user) {
      const uid = sessions.user.id,
        options = { userId: uid, pageSize: 100 };
      db.users = [
        queryRecord<Database["users"][number]>(sql, "users", uid)!,
      ].filter(Boolean);
      db.carts = queryPage<CartItem>(sql, "carts", options).items;
      db.addresses = queryPage<Database["addresses"][number]>(
        sql,
        "addresses",
        options,
      ).items;
      db.couponClaims = queryPage<Database["couponClaims"][number]>(
        sql,
        "couponClaims",
        options,
      ).items;
      const couponTemplates = new Map(db.coupons.map((c) => [c.id, c]));
      for (const claim of db.couponClaims) {
        if (!couponTemplates.has(claim.couponId)) {
          const coupon = queryRecord<Database["coupons"][number]>(
            sql,
            "coupons",
            claim.couponId,
          );
          if (coupon) couponTemplates.set(coupon.id, coupon);
        }
      }
      db.coupons = [...couponTemplates.values()];
      db.favorites = {
        [uid]: queryRecord<string[]>(sql, "favorites", uid) ?? [],
      };
      const known = new Set(db.products.map((product) => product.id));
      const missing = [
        ...new Set(db.carts.map((cart) => cart.productId)),
      ].filter((id) => !known.has(id));
      db.products.push(
        ...projectedProducts(
          sql,
          missing
            .map((id) => queryRecord<Product>(sql, "products", id))
            .filter((product): product is Product => !!product),
        ),
      );
    }
    const memberSummary = sessions.user
      ? queryMemberSummary(sql, sessions.user.id)
      : null;
    res.json({ db, sessions, memberSummary });
  });
  app.get("/api/collections/:collection", (req, res) => {
    const collection = String(req.params.collection) as keyof Database;
    if (hiddenCollections.has(collection))
      throw new HttpError(404, "此集合不支持公开查询");
    const role = z.enum(["user", "admin"]).parse(req.query.role ?? "user");
    const session =
      role === "admin"
        ? signed(sql, req, "admin")
        : findSession(sql, req, "user");
    if (!publicCollections.has(collection)) {
      if (!session) throw new HttpError(401, "请先登录");
      if (role === "admin") {
        const permissions = collectionPermission(collection);
        if (
          !permissions.length ||
          !permissions.some((p) => permits(session, p))
        )
          throw new HttpError(403, "当前员工没有此查询权限");
      } else if (!privateCollections.has(collection))
        throw new HttpError(403, "不允许查询此集合");
    }
    const page = pageNumber.parse(req.query.page ?? 1),
      size = pageSize.parse(req.query.pageSize ?? 20);
    if (collection === "auditEntries") {
      const total = (
        sql.prepare("SELECT count(*) AS n FROM operation_audit").get() as {
          n: number;
        }
      ).n;
      const items = sql
        .prepare(
          "SELECT id,actor_id AS actorId,action,request_id AS requestId,object_id AS objectId,result,created_at AS createdAt FROM operation_audit ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
        )
        .all(size, (page - 1) * size);
      return void res.json({
        items,
        total,
        page,
        pageSize: size,
        pages: Math.max(1, Math.ceil(total / size)),
        revision: meta(sql).revision,
      });
    }
    if (
      !sql
        .prepare("SELECT 1 FROM storage_domains WHERE name=? AND kind='array'")
        .get(collection)
    )
      throw new HttpError(404, "集合不存在");
    const options: Parameters<typeof queryPage>[2] = {
      page,
      pageSize: size,
      sort: "newest",
    };
    if (role === "user" && privateCollections.has(collection))
      options.userId = session!.id;
    if (collection === "users" && role === "user") {
      const item = queryRecord(sql, "users", session!.id);
      return void res.json({
        items: item ? [item] : [],
        total: item ? 1 : 0,
        page: 1,
        pageSize: size,
        pages: 1,
        revision: meta(sql).revision,
      });
    }
    if (req.query.status) {
      const status = z.string().max(60).parse(req.query.status);
      if (collection === "products" && ["true", "false"].includes(status))
        options.active = status === "true";
      else if (
        ["coupons", "faqs", "promotions", "suppliers"].includes(collection) &&
        ["active", "inactive"].includes(status)
      )
        options.active = status === "active";
      else options.status = status;
    }
    if (req.query.productId)
      options.productId = z.string().max(100).parse(req.query.productId);
    if (req.query.category)
      options.categoryId = z.string().max(100).parse(req.query.category);
    if (req.query.search || req.query.q)
      options.search = z
        .string()
        .trim()
        .max(100)
        .parse(req.query.search ?? req.query.q);
    if (collection === "conversations" && req.query.locate !== undefined)
      options.locateId = z.string().min(1).max(100).parse(req.query.locate);
    if (req.query.sort)
      options.sort = z
        .enum([
          "newest",
          "oldest",
          "position",
          "price-asc",
          "price-desc",
          "priceAsc",
          "priceDesc",
          "sales",
          "featured",
          "asc",
          "desc",
        ])
        .parse(req.query.sort);
    if (req.query.type)
      options.type = z
        .enum(["payment", "refund", "purchase"])
        .parse(req.query.type);
    for (const field of ["from", "to"] as const)
      if (req.query[field])
        options[field] = z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine(
            (value) =>
              Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
              new Date(`${value}T12:00:00Z`).toISOString().startsWith(value),
          )
          .parse(req.query[field]);
    if (req.query.min)
      options.min =
        z.coerce.number().finite().nonnegative().parse(req.query.min) * 100;
    if (req.query.max)
      options.max =
        z.coerce.number().finite().nonnegative().parse(req.query.max) * 100;
    if (req.query.stock === "1") options.inStock = true;
    if (req.query.id)
      options.ids = z
        .string()
        .max(10100)
        .parse(req.query.id)
        .split(",")
        .slice(0, 100);
    if (req.query.favorites === "1") {
      if (collection !== "products" || role !== "user" || !session)
        throw new HttpError(401, "请先登录用户账号");
      options.favoriteUserId = session.id;
    }
    if (req.query.orderId)
      options.orderId = z.string().max(100).parse(req.query.orderId);
    if (collection === "products") {
      if (role === "user" && !options.ids && !options.favoriteUserId)
        options.active = true;
      if (!req.query.sort) options.sort = "position";
    }
    if (collection === "faqs" && role === "user") options.active = true;
    if (collection === "coupons" && role === "user") {
      options.active = true;
      options.claimEndsAfter = new Date().toISOString();
    }
    if (!req.query.sort && collection === "categories") options.sort = "asc";
    if (!req.query.sort && collection === "faqs") options.sort = "position";
    const result =
      collection === "products" &&
      req.query.view === "inventory" &&
      role === "admin"
        ? (demand(session, "warehouse"), stockPage(sql, req, options))
        : queryPage<unknown>(sql, collection, options);
    if (collection === "products")
      result.items = projectedProducts(
        sql,
        result.items as Product[],
        role === "admin",
      );
    if (collection === "categories")
      result.items = result.items.map((value) => {
        const c = value as { id: string };
        return {
          ...c,
          productCount: (
            sql
              .prepare(
                `SELECT count(*) AS n FROM biz_products WHERE category_id=?${role === "user" ? " AND active=1" : ""}`,
              )
              .get(c.id) as { n: number }
          ).n,
        };
      });
    if (collection === "coupons")
      result.items = result.items.map((value) => {
        const c = value as { id: string };
        return {
          ...c,
          claimedCount: (
            sql
              .prepare(
                "SELECT count(*) AS n FROM biz_coupon_claims WHERE json_extract(data,'$.couponId')=?",
              )
              .get(c.id) as { n: number }
          ).n,
        };
      });
    res.json({
      ...result,
      revision: meta(sql).revision,
      related: relatedRecords(sql, collection, result.items, session, role),
    });
  });
  app.get("/api/member/points", (req, res) => {
    const session = signed(sql, req, "user");
    const balance = (
      sql
        .prepare(
          "SELECT coalesce(sum(json_extract(data,'$.delta')),0) AS balance FROM biz_points_entries WHERE user_id=?",
        )
        .get(session.id) as { balance: number }
    ).balance;
    res.json({ balance });
  });
  app.get("/api/requests/:id", (req, res) => {
    const method = z.string().min(1).max(100).parse(req.query.method),
      requestId = z.string().min(1).max(128).parse(req.params.id);
    const sessions = [
      findSession(sql, req, "user"),
      findSession(sql, req, "admin"),
    ].filter((s): s is Session => !!s);
    if (!sessions.length) throw new HttpError(401, "请先登录");
    const result = sessions
      .map(
        (s) =>
          sql
            .prepare(
              "SELECT result FROM command_results WHERE actor_id=? AND method=? AND request_id=?",
            )
            .get(s.id, method, requestId) as { result: string } | undefined,
      )
      .find(Boolean);
    res.json(
      result
        ? { found: true, result: JSON.parse(result.result) }
        : { found: false },
    );
  });
  app.get("/api/admin/staff", (req, res) => {
    demand(signed(sql, req, "admin"), "staff");
    res.json({
      items: sql
        .prepare(
          "SELECT a.id,a.username,a.name,s.staff_role AS staffRole,s.active FROM accounts a JOIN staff_access s ON s.account_id=a.id WHERE a.role='admin' ORDER BY a.created_at LIMIT 100",
        )
        .all()
        .map((v) => ({ ...v, active: !!v.active })),
    });
  });
  app.get("/api/admin/jobs", (req, res) => {
    demand(signed(sql, req, "admin"), "settings");
    const status = z
      .enum(["all", "pending", "failed", "done"])
      .parse(req.query.status ?? "all");
    const size = pageSize.parse(req.query.pageSize ?? 20);
    const requested = pageNumber.parse(req.query.page ?? 1);
    const where = status === "all" ? "" : " WHERE status=?";
    const parameters = status === "all" ? [] : [status];
    const total = Number(
      sql
        .prepare(`SELECT count(*) total FROM job_queue${where}`)
        .get(...parameters)!.total,
    );
    const pages = Math.max(1, Math.ceil(total / size)),
      page = Math.min(requested, pages);
    res.json({
      items: sql
        .prepare(
          `SELECT id,kind,status,attempts,run_after AS runAfter,last_error AS lastError,retry_version AS retryVersion FROM job_queue${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(...parameters, size, (page - 1) * size),
      total,
      page,
      pageSize: size,
      pages,
    });
  });
  const reconciliation = createReconciliationReader(sql);
  app.get("/api/admin/reconciliation", async (req, res) => {
    demand(signed(sql, req, "admin"), "finance");
    const result = await reconciliation();
    demand(signed(sql, req, "admin"), "finance");
    res.json(result);
  });
  app.get("/api/admin/dashboard", (req, res) => {
    res.json(dashboard(sql, signed(sql, req, "admin")));
  });
}
