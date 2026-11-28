import { afterEach, beforeEach, expect, it } from "vitest";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { CheckoutQuote, Order } from "../../shared/domain/types";
import { defaultWarehouseId } from "../../shared/domain/warehouses";
import type {
  Parcel,
  StockTransfer,
  Warehouse,
} from "../../shared/domain/warehouses";
import { createApp } from "../src/app";
import { tokenHash } from "../src/auth";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { availableStock } from "../src/commerce-rules";
import { migrateDatabase } from "../src/migration";
import { stockRow } from "../src/warehouse-stock";

let sql: DatabaseSync, server: Server, base: string;
const origin = "http://localhost";
function cookie(actor: string) {
  return `shopmate_${actor === "buyer" ? "user" : "admin"}=${actor}-token`;
}
function get(path: string, actor: string) {
  return fetch(base + path, { headers: { Cookie: cookie(actor) } });
}
function post(
  method: string,
  args: unknown[],
  actor = "owner",
  requestId: string = crypto.randomUUID(),
) {
  return fetch(`${base}/api/actions/${method}`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie(actor),
      "Content-Type": "application/json",
      "X-ShopMate-Request": "1",
    },
    body: JSON.stringify({ args, requestId }),
  });
}
async function action<T = void>(
  method: string,
  args: unknown[],
  actor?: string,
  requestId?: string,
): Promise<T> {
  const response = await post(method, args, actor, requestId);
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(200);
  return data.result;
}

beforeEach(async () => {
  sql = openDatabase(":memory:");
  const app = await createApp(sql, { origins: [origin] });
  for (const [id, role] of [
    ["buyer", "user"],
    ["owner", "admin"],
    ["east-staff", "admin"],
  ]) {
    sql
      .prepare(
        "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, id, id, role, "test-fixture", 1);
    sql
      .prepare(
        "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)",
      )
      .run(tokenHash(`${id}-token`), id, Date.now() + 60000);
  }
  sql
    .prepare(
      "INSERT INTO staff_access VALUES('owner','owner',1),('east-staff','warehouse',1)",
    )
    .run();
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sql.close();
});

it("scopes stock and shipments, settles split-order refunds and reconciles physical stock", async () => {
  const east = await action<Warehouse>("saveWarehouse", [
    {
      name: "华东仓",
      priority: 10,
      provinces: ["上海"],
      acceptsOrders: true,
    },
  ]);
  await action("assignWarehouses", ["east-staff", [east.id]]);
  const productId = "p01",
    skuId = "p01-s1";
  const initial = readDatabase(sql).products[0]!.skus[0]!.stock;
  await action("adjustStock", [
    productId,
    skuId,
    2,
    0,
    "测试默认仓盘点",
    {
      requestId: "count-default",
      mode: "count",
      expectedStock: initial,
    },
  ]);
  await action("adjustStock", [
    productId,
    skuId,
    2,
    0,
    "测试华东仓入库",
    {
      requestId: "fill-east",
      warehouseId: east.id,
    },
  ]);
  expect(
    (
      await post(
        "adjustStock",
        [
          productId,
          skuId,
          1,
          0,
          "越仓测试",
          {
            requestId: "outside",
            warehouseId: defaultWarehouseId,
          },
        ],
        "east-staff",
      )
    ).status,
  ).toBe(403);

  await action(
    "saveAddress",
    [
      {
        name: "隔离顾客",
        phone: "13800138000",
        province: "上海市",
        region: "上海市 浦东新区",
        detail: "验收测试地址",
        isDefault: true,
      },
    ],
    "buyer",
  );
  const addressId = readDatabase(sql).addresses[0]!.id;
  const checkout = {
    addressId,
    source: { type: "buyNow", productId, skuId, quantity: 4 },
  };
  const quote = await action<CheckoutQuote>(
    "quoteCheckout",
    [checkout],
    "buyer",
  );
  expect(quote.allocations).toEqual([
    expect.objectContaining({ warehouseId: defaultWarehouseId, quantity: 2 }),
    expect.objectContaining({ warehouseId: east.id, quantity: 2 }),
  ]);
  const orderId = await action<string>(
    "createOrder",
    [{ quoteId: quote.id, requestId: "split-order" }],
    "buyer",
  );
  await action("payOrder", [orderId], "buyer");
  const getOrder = () =>
    readDatabase(sql).orders.find((order) => order.id === orderId)!;
  const order = getOrder();
  const defaultAllocation = order.allocations!.find(
    (line) => line.warehouseId === defaultWarehouseId,
  )!;
  const eastAllocation = order.allocations!.find(
    (line) => line.warehouseId === east.id,
  )!;
  const shipment = {
    warehouseId: defaultWarehouseId,
    carrier: "模拟物流",
    tracking: "SPLIT-DEFAULT-1",
    lines: [
      {
        allocationId: defaultAllocation.id,
        quantity: 2,
      },
    ],
  };
  const scoped = await get(
    `/api/collections/orders?role=admin&id=${orderId}`,
    "east-staff",
  );
  const result = (await scoped.json()) as { items: Order[] };
  expect(result.items[0]!.allocations).toEqual([eastAllocation]);
  expect(
    (await post("shipParcel", [orderId, shipment], "east-staff")).status,
  ).toBe(403);
  const parcel = await action<Parcel>(
    "shipParcel",
    [orderId, shipment],
    "owner",
    "one-shipment",
  );
  expect(
    await action<Parcel>(
      "shipParcel",
      [orderId, shipment],
      "owner",
      "one-shipment",
    ),
  ).toEqual(parcel);
  expect(getOrder().parcels).toHaveLength(1);

  await action(
    "requestAfterSale",
    [
      orderId,
      "取消未发商品",
      "退两件未发商品",
      [{ orderItemId: order.items[0]!.id, quantity: 2 }],
    ],
    "buyer",
  );
  const cancellation = readDatabase(sql).afterSales[0]!;
  expect(cancellation.requiresReturn).toBe(false);
  await action("processAfterSale", [cancellation.id, "approve"]);
  expect(
    (
      await post(
        "shipParcel",
        [
          orderId,
          {
            warehouseId: east.id,
            carrier: "模拟物流",
            tracking: "SPLIT-EAST-1",
            lines: [{ allocationId: eastAllocation.id, quantity: 2 }],
          },
        ],
        "east-staff",
      )
    ).status,
  ).toBe(400);
  await action("processAfterSale", [cancellation.id, "refund"]);
  expect(getOrder().status).toBe("shipped");
  await action("confirmOrder", [orderId, parcel.id], "buyer");
  expect(getOrder().status).toBe("completed");

  await action(
    "requestAfterSale",
    [
      orderId,
      "退回已收货商品",
      "退回两件商品",
      [{ orderItemId: order.items[0]!.id, quantity: 2 }],
    ],
    "buyer",
  );
  const sale = readDatabase(sql).afterSales[0]!;
  expect(sale.requiresReturn).toBe(true);
  const returned = sale.returnParcels![0]!;
  await action("processAfterSale", [sale.id, "approve"]);
  await action(
    "submitReturn",
    [sale.id, "模拟物流", "RETURN-DEFAULT-1", returned.id],
    "buyer",
  );
  expect(
    (
      await post(
        "processAfterSale",
        [sale.id, "receive", "", returned.id],
        "east-staff",
      )
    ).status,
  ).toBe(403);
  await action("processAfterSale", [sale.id, "receive", "", returned.id]);
  const inspection = readDatabase(sql).returnInspections![0]!;
  await action("inspectReturn", [
    {
      id: inspection.id,
      version: inspection.version,
      good: 1,
      defective: 1,
      note: "隔离次品",
    },
  ]);
  await action("processAfterSale", [sale.id, "refund"]);
  const final = readDatabase(sql);
  expect(
    final.ledger.filter(
      (entry) => entry.reference === orderId && entry.type === "payment",
    ),
  ).toHaveLength(1);
  expect(
    final.ledger
      .filter((entry) => entry.reference === orderId && entry.type === "refund")
      .reduce((total, entry) => total + entry.amount, 0),
  ).toBe(order.total);
  expect(stockRow(final, defaultWarehouseId, productId, skuId)).toMatchObject({
    onHand: 1,
    committed: 0,
    defective: 1,
  });
  expect(stockRow(final, east.id, productId, skuId)).toMatchObject({
    onHand: 2,
    committed: 0,
  });
  expect(availableStock(final, productId, skuId)).toBe(3);
});

it("keeps transfer stock unavailable in transit and accounts for partial receipts and loss", async () => {
  const east = await action<Warehouse>("saveWarehouse", [
    { name: "接收仓", priority: 10, provinces: [], acceptsOrders: true },
  ]);
  const initial = availableStock(readDatabase(sql), "p01", "p01-s1");
  const transfer = await action<StockTransfer>("createStockTransfer", [
    defaultWarehouseId,
    east.id,
    [{ productId: "p01", skuId: "p01-s1", quantity: 3 }],
  ]);
  expect(availableStock(readDatabase(sql), "p01", "p01-s1")).toBe(initial - 3);
  const sent = await action<StockTransfer>("dispatchStockTransfer", [
    transfer.id,
    transfer.version,
  ]);
  const partial = await action<StockTransfer>("receiveStockTransfer", [
    sent.id,
    sent.version,
    [{ skuId: "p01-s1", quantity: 1 }],
  ]);
  expect(partial.status).toBe("inTransit");
  expect(
    (
      await post("receiveStockTransfer", [
        sent.id,
        sent.version,
        [{ skuId: "p01-s1", quantity: 1 }],
      ])
    ).status,
  ).toBe(409);
  const closed = await action<StockTransfer>("receiveStockTransfer", [
    partial.id,
    partial.version,
    [{ skuId: "p01-s1", quantity: 1, discrepancy: 1 }],
    "运输少收一件",
  ]);
  expect(closed.status).toBe("received");
  expect(availableStock(readDatabase(sql), "p01", "p01-s1")).toBe(initial - 1);
});

it("moves paid legacy quantities into committed stock without changing saleable counts or money", () => {
  const old = readDatabase(sql);
  const sku = old.products[0]!.skus[0]!;
  const paidQuantity = 2;
  old.version = 5;
  old.orders = [
    {
      id: "old-paid",
      userId: "buyer",
      status: "paid",
      events: [],
      discount: 0,
      total: sku.price * paidQuantity,
      subtotal: sku.price * paidQuantity,
      refundedAmount: 0,
      createdAt: "2026-10-01T08:00:00Z",
      address: {
        id: "old-address",
        userId: "buyer",
        name: "顾客",
        phone: "",
        region: "上海市",
        detail: "",
        isDefault: true,
      },
      items: [
        {
          id: "old-item",
          discount: 0,
          total: sku.price * paidQuantity,
          refundedQuantity: 0,
          productId: old.products[0]!.id,
          skuId: sku.id,
          name: "旧订单",
          skuName: sku.name,
          image: "",
          price: sku.price,
          quantity: paidQuantity,
        },
      ],
    },
  ];
  const originalOnBook = sku.stock;
  expect(migrateDatabase(old, "2026-11-28T00:00:00Z")).toBe(true);
  writeDatabase(sql, old);
  const migrated = readDatabase(sql);
  expect(migrated.orders[0]!.total).toBe(sku.price * paidQuantity);
  expect(migrated.ledger).toEqual([]);
  expect(availableStock(migrated, old.products[0]!.id, sku.id)).toBe(
    originalOnBook,
  );
  expect(
    stockRow(migrated, defaultWarehouseId, old.products[0]!.id, sku.id),
  ).toMatchObject({
    onHand: originalOnBook + paidQuantity,
    committed: paidQuantity,
  });
  expect(migrateDatabase(migrated)).toBe(false);
});
