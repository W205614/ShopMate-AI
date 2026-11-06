import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "../../../shared/domain/types";

// Older migration evidence lacks some collections and order event fields.
export function redactAccountDomain(db: Partial<Database>, userId: string) {
  const present =
    db.users?.some((row) => row.id === userId) ||
    (db.favorites && Object.hasOwn(db.favorites, userId)) ||
    [
      db.addresses,
      db.carts,
      db.orders,
      db.checkoutQuotes,
      db.afterSales,
      db.reviews,
      db.conversations,
      db.notifications,
    ].some((rows) => rows?.some((row) => row.userId === userId));
  if (!present) return false;
  const profile = db.users?.find((row) => row.id === userId);
  if (profile) {
    profile.name = "已注销用户";
    profile.username = `closed-${userId}`;
  }
  if (db.addresses)
    db.addresses = db.addresses.filter((row) => row.userId !== userId);
  if (db.carts) db.carts = db.carts.filter((row) => row.userId !== userId);
  if (db.favorites) delete db.favorites[userId];
  if (db.conversations)
    db.conversations = db.conversations.filter((row) => row.userId !== userId);
  if (db.notifications)
    db.notifications = db.notifications.filter((row) => row.userId !== userId);
  for (const order of db.orders ?? []) {
    if (order.userId !== userId) continue;
    order.address = {
      ...order.address,
      name: "已注销用户",
      phone: "",
      region: "",
      detail: "",
    };
    delete order.address.province;
    delete order.tracking;
    delete order.carrier;
    for (const event of order.events ?? []) delete event.note;
  }
  for (const quote of db.checkoutQuotes ?? []) {
    if (quote.userId !== userId) continue;
    quote.address = {
      ...quote.address,
      name: "已注销用户",
      phone: "",
      region: "",
      detail: "",
    };
    delete quote.address.province;
  }
  for (const sale of db.afterSales ?? []) {
    if (sale.userId !== userId) continue;
    sale.reason = "";
    sale.description = "";
    sale.note = "";
    delete sale.returnTracking;
    delete sale.returnCarrier;
    for (const event of sale.events ?? []) delete event.note;
  }
  for (const review of db.reviews ?? []) {
    if (review.userId !== userId) continue;
    review.content = "";
    review.deleted = true;
  }
  return true;
}

export function redactLegacyAccount(sql: DatabaseSync, userId: string) {
  const original = String(
    sql.prepare("SELECT data FROM state WHERE id=1").get()!.data,
  );
  const legacy = JSON.parse(original) as Partial<Database>;
  if (!redactAccountDomain(legacy, userId)) return undefined;
  const redacted = JSON.stringify(legacy);
  // The closure transaction is the sole exception to immutable migration evidence.
  // Rollback restores both the source bytes and trigger if any later closure step fails.
  sql.exec("DROP TRIGGER legacy_state_immutable_update");
  sql.prepare("UPDATE state SET data=? WHERE id=1").run(redacted);
  sql.exec(
    "CREATE TRIGGER legacy_state_immutable_update BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT,'legacy state is read-only migration evidence'); END",
  );
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return { before: digest(original), after: digest(redacted) };
}
