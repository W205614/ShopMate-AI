/** Isolated data only. Reuses the historical seed then adds independently owned working sets. */
import "./seed-load";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
  transaction,
} from "../src/database";
import { ensureRuntimeSchema } from "../src/runtime";
import { ensureKnowledgeSchema } from "../src/ai-knowledge";
const sql = openDatabase(process.env.DATABASE_PATH!);
const users = 50;
try {
  ensureRuntimeSchema(sql);
  ensureKnowledgeSchema(sql);
  transaction(sql, () => {
    const db = readDatabase(sql),
      template = db.orders[0]!;
    const account = sql
      .prepare("SELECT password_hash FROM accounts WHERE username='loaduser'")
      .get()!;
    for (let i = 0; i < users; i++) {
      const uid = `stability-${i}`,
        at = new Date().toISOString();
      sql
        .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
        .run(
          uid,
          `stability_${i}`,
          "隔离验收",
          "user",
          account.password_hash,
          Date.now(),
        );
      db.users.push({
        id: uid,
        username: `stability_${i}`,
        name: "隔离验收",
        createdAt: at,
      } as DatabaseUser);
      for (let j = 0; j < 20; j++)
        db.carts.push({
          id: `${uid}-cart-${j}`,
          userId: uid,
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
          selected: true,
        });
      db.addresses.push({
        ...template.address,
        id: `${uid}-address`,
        userId: uid,
      });
      db.notifications ??= [];
      for (let j = 0; j < 200; j++)
        db.notifications.push({
          id: `${uid}-notice-${j}`,
          userId: uid,
          text: "隔离历史通知",
          read: j % 2 === 0,
          createdAt: at,
        });
      const oid = `${uid}-reserved`;
      const pending = {
        ...structuredClone(template),
        id: oid,
        userId: uid,
        address: { ...template.address, id: `${uid}-address`, userId: uid },
        status: "pending" as const,
        inventoryPolicy: "reserved-v1" as const,
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        items: template.items.map((item, line) => ({
          ...item,
          id: `${oid}-${line}`,
        })),
        events: [],
      };
      delete pending.paidAt;
      delete pending.shippedAt;
      delete pending.completedAt;
      db.orders.push(pending);
    }
    for (const order of db.orders.filter((order) =>
      order.id.startsWith("history-"),
    )) {
      db.checkoutQuotes.push({
        id: `quote-${order.id}`,
        userId: order.userId,
        orderId: order.id,
        input: {
          addressId: "load-address",
          source: {
            type: "buyNow",
            productId: "p01",
            skuId: "p01-s1",
            quantity: 1,
          },
        },
        items: structuredClone(order.items),
        address: structuredClone(order.address),
        subtotal: order.subtotal,
        discount: order.discount,
        total: order.total,
        createdAt: order.createdAt,
        expiresAt: order.createdAt,
        fingerprint: "isolated-finalized-history",
      });
    }
    const baselineActor = sql
      .prepare("SELECT id FROM accounts WHERE username='loaduser'")
      .get()!.id;
    for (let i = 0; i < 10000; i++) {
      sql
        .prepare("INSERT INTO command_results VALUES(?,?,?,?,?,?)")
        .run(
          baselineActor,
          "baseline",
          `baseline-${i}`,
          "isolated",
          "null",
          template.createdAt,
        );
      sql
        .prepare(
          "INSERT INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES(?,?,?,'done',0,?)",
        )
        .run(`baseline-${i}`, "notification", "{}", template.createdAt);
    }
    db.revision++;
    writeDatabase(sql, db);
  });
  console.log(
    JSON.stringify({
      event: "stability_seeded",
      users,
      historicalOrders: 10000,
      finalizedQuotes: 10000,
      commands: 10000,
      completedJobs: 10000,
      carts: 1001,
      notifications: 10000,
      reservations: users,
    }),
  );
} finally {
  sql.close();
}
type DatabaseUser = ReturnType<typeof readDatabase>["users"][number];
