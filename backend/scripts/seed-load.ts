import {
  openDatabase,
  readDatabase,
  writeDatabase,
  transaction,
} from "../src/database";
import { createAccount } from "../src/auth";
if (
  process.env.SHOPMATE_ENV !== "acceptance" ||
  process.env.LOAD_TEST_ALLOWED !== "1"
)
  throw new Error(
    "Load seeding is restricted to explicitly enabled acceptance containers",
  );
const count = Number(process.env.LOAD_HISTORY ?? "0");
if (![0, 10000].includes(count)) throw new Error("Unsupported load dataset");
const sql = openDatabase(process.env.DATABASE_PATH!);
if (sql.prepare("SELECT id FROM accounts WHERE username='loaduser'").get())
  throw new Error("Use a fresh isolated volume for each dataset");
const account = await createAccount(sql, {
  username: "loaduser",
  name: "并发验收用户",
  password: process.env.LOAD_PASSWORD!,
});
transaction(sql, () => {
  const db = readDatabase(sql),
    product = db.products[0]!,
    sku = product.skus[0]!,
    at = "2026-01-01T00:00:00.000Z";
  const before = sku.stock;
  sku.stock = 1_000_000;
  db.inventory.unshift({
    id: "load-initial-adjustment",
    productId: product.id,
    skuId: sku.id,
    delta: 1_000_000 - before + count,
    reason: "隔离容量数据期初",
    createdAt: at,
  });
  if (count)
    db.inventory.push({
      id: "load-historical-sales",
      productId: product.id,
      skuId: sku.id,
      delta: -count,
      reason: "隔离历史销售汇总",
      createdAt: at,
    });
  const address = {
    id: "load-address",
    userId: account.id,
    name: "验收",
    phone: "13800000000",
    province: "上海",
    region: "上海",
    detail: "隔离验收地址",
    isDefault: true,
  };
  db.addresses.push(address);
  db.carts.push({
    id: "load-cart",
    userId: account.id,
    productId: product.id,
    skuId: sku.id,
    quantity: 1,
    selected: true,
  });
  for (let i = 0; i < count; i++) {
    const oid = `history-${String(i).padStart(6, "0")}`;
    db.orders.push({
      id: oid,
      userId: account.id,
      items: [
        {
          id: oid + "-line",
          productId: product.id,
          skuId: sku.id,
          name: product.name,
          skuName: sku.name,
          image: product.images[0]!,
          price: 1000,
          quantity: 1,
          discount: 0,
          total: 1000,
          refundedQuantity: 0,
        },
      ],
      subtotal: 1000,
      discount: 0,
      total: 1000,
      refundedAmount: 0,
      status: "completed",
      address,
      createdAt: at,
      paidAt: at,
      shippedAt: at,
      completedAt: at,
      events: [],
    });
    db.ledger.push({
      id: "payment-" + oid,
      type: "payment",
      amount: 1000,
      reference: oid,
      note: "隔离历史收款",
      createdAt: at,
    });
  }
  db.revision++;
  writeDatabase(sql, db);
});
console.log(JSON.stringify({ history: count, status: "seeded" }));
sql.close();
