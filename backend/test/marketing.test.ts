import { readSnapshot } from "./http-snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import { createAccount } from "../src/auth";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { marketingApi, publicReviews } from "../src/marketing";
import { commerceApi } from "../src/commerce";
import { context } from "../src/repository";
import type { Database, Session } from "../../shared/domain/types";

let sql: DatabaseSync, server: Server, base: string;
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0]!;
async function post(path: string, body: unknown, cookie = "") {
  return fetch(base + path, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify(body),
  });
}
async function snapshot(cookie = "", role = "user") {
  return readSnapshot(base, cookie, role);
}
beforeEach(async () => {
  sql = openDatabase(":memory:");
  const app = await createApp(sql, { origins: ["http://localhost"], allowLegacyCommands: true });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  sql.close();
});
const coupon = () => ({
  name: "验收满减券",
  threshold: 200,
  discount: 100,
  totalLimit: 2,
  active: true,
  claimStartsAt: new Date(Date.now() - 60000).toISOString(),
  claimEndsAt: new Date(Date.now() + 3600000).toISOString(),
  validFrom: new Date(Date.now() - 60000).toISOString(),
  validUntil: new Date(Date.now() + 86400000).toISOString(),
});
let user: Session | null;
const administrator: Session = { id: "admin", role: "admin", name: "管理员" };
const run = <T>(fn: () => T) =>
  context.run({ sql, user, admin: administrator }, fn);
function seed() {
  writeDatabase(sql, createSeed());
  user = { id: "u1", role: "user", name: "林小满" };
}

// Privacy fixtures retain valid references so database constraints remain exercised.
function privateOrder(db: Database, uid: string, orderId: string) {
  const order = structuredClone(createSeed().orders[0]!);
  order.id = orderId;
  order.userId = uid;
  order.address.userId = uid;
  order.items = order.items.map((item, index) => ({
    ...item,
    id: `${orderId}-line-${index}`,
  }));
  db.orders.push(order);
  db.ledger.push({
    id: `${orderId}-payment`,
    type: "payment",
    amount: order.total,
    reference: orderId,
    note: "有效隐私测试订单",
    createdAt: order.paidAt!,
  });
  return order;
}

describe("profile and marketing boundaries", () => {
  it("projects global coupon counts without private claims or persisted display fields", async () => {
    await createAccount(
      sql,
      { username: "couponadmin", name: "券管理", password: "CouponAdmin123!" },
      "admin",
    );
    const adminCookie = cookieOf(
      await post("/api/auth/login", {
        username: "couponadmin",
        password: "CouponAdmin123!",
        role: "admin",
      }),
    );
    const a = cookieOf(
      await post("/api/auth/register", {
        username: "claimera",
        name: "领取者甲",
        password: "CouponUser123!",
      }),
    );
    const b = cookieOf(
      await post("/api/auth/register", {
        username: "claimerb",
        name: "领取者乙",
        password: "CouponUser123!",
      }),
    );
    expect(
      (await post("/api/actions/saveCoupon", { args: [coupon()] }, adminCookie))
        .status,
    ).toBe(200);
    const original = readDatabase(sql).coupons[0]!;
    expect(
      (
        await post(
          "/api/actions/saveCoupon",
          { args: [{ ...original, name: "未领取可编辑券" }] },
          adminCookie,
        )
      ).status,
    ).toBe(200);
    expect(readDatabase(sql).coupons[0]!.name).toBe("未领取可编辑券");
    expect(
      (await post("/api/actions/claimCoupon", { args: [original.id] }, a))
        .status,
    ).toBe(200);
    const before = readDatabase(sql);
    for (const [cookie, role, own] of [
      ["", "user", 0],
      [a, "user", 1],
      [b, "user", 0],
      [adminCookie, "admin", 1],
    ] as const) {
      const visible = await snapshot(cookie, role);
      expect(visible.db.coupons[0]).toMatchObject({ claimedCount: 1 });
      expect(visible.db.couponClaims).toHaveLength(own);
      if (!own)
        expect(JSON.stringify(visible.db.coupons[0])).not.toContain(
          before.couponClaims[0]!.id,
        );
    }
    expect(readDatabase(sql)).toEqual(before);
    expect(readDatabase(sql).coupons[0]).not.toHaveProperty("claimedCount");
    expect(
      (
        await post(
          "/api/actions/saveCoupon",
          { args: [{ ...original, claimedCount: 999 }] },
          adminCookie,
        )
      ).status,
    ).toBe(400);
    expect(readDatabase(sql)).toEqual(before);
    expect(
      (
        await post(
          "/api/actions/saveCoupon",
          {
            args: [
              {
                ...readDatabase(sql).coupons[0]!,
                discount: original.discount + 1,
              },
            ],
          },
          adminCookie,
        )
      ).status,
    ).toBe(400);
    for (const status of ["locked", "used"] as const) {
      const changed = readDatabase(sql);
      changed.couponClaims[0]!.status = status;
      changed.couponClaims[0]!.orderId = "historical-order";
      if (!changed.orders.some((o) => o.id === "historical-order"))
        privateOrder(
          changed,
          changed.couponClaims[0]!.userId,
          "historical-order",
        );
      writeDatabase(sql, changed);
      expect((await snapshot(b)).db.coupons[0].claimedCount).toBe(1);
    }
  });
  it("requires an admin and matching settings baseline over HTTP, including empty announcements", async () => {
    const baseline = readDatabase(sql).settings;
    const input = { ...baseline, notice: "", name: "HTTP 设置" };
    expect(
      (await post("/api/actions/saveSettings", { args: [input, baseline] }))
        .status,
    ).toBe(401);
    await createAccount(
      sql,
      { username: "admin", name: "管理员", password: "AdminPass123!" },
      "admin",
    );
    const cookie = cookieOf(
      await post("/api/auth/login", {
        role: "admin",
        username: "admin",
        password: "AdminPass123!",
      }),
    );
    expect(
      (await post("/api/actions/saveSettings", { args: [input] }, cookie))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/actions/saveSettings",
          { args: [input, baseline] },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/api/actions/saveSettings",
          { args: [{ ...input, name: "冲突覆盖" }, baseline] },
          cookie,
        )
      ).status,
    ).toBe(409);
    expect(readDatabase(sql).settings).toMatchObject(input);
    expect(readDatabase(sql).settings.version).toBe(2);
  });
  it("validates profile and revokes every user session after password change while preserving admin", async () => {
    const input = {
      username: "alice",
      name: "小艾",
      password: "AlicePass123!",
    };
    const first = cookieOf(await post("/api/auth/register", input));
    const second = cookieOf(
      await post("/api/auth/login", {
        role: "user",
        username: "alice",
        password: input.password,
      }),
    );
    await createAccount(
      sql,
      { username: "admin", name: "管理员", password: "AdminPass123!" },
      "admin",
    );
    const admin = cookieOf(
      await post("/api/auth/login", {
        role: "admin",
        username: "admin",
        password: "AdminPass123!",
      }),
    );
    expect(
      (await post("/api/auth/profile", { name: "改名", role: "admin" }, first))
        .status,
    ).toBe(400);
    expect(
      (await post("/api/auth/profile", { name: "  新昵称  " }, first)).status,
    ).toBe(200);
    expect((await snapshot(second)).sessions.user!.name).toBe("新昵称");
    expect((await snapshot(second)).db.users[0].name).toBe("新昵称");
    expect(
      (
        await post(
          "/api/auth/password",
          { currentPassword: "wrong", newPassword: "NewPassword123!" },
          first,
        )
      ).status,
    ).toBe(400);
    expect((await snapshot(second)).sessions.user).not.toBeNull();
    expect(
      (
        await post(
          "/api/auth/password",
          { currentPassword: input.password, newPassword: "NewPassword123!" },
          `${first}; ${admin}`,
        )
      ).status,
    ).toBe(200);
    expect((await snapshot(first)).sessions.user).toBeNull();
    expect((await snapshot(second)).sessions.user).toBeNull();
    expect((await snapshot(admin, "admin")).sessions.admin!.role).toBe("admin");
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: "alice",
          password: input.password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: "alice",
          password: "NewPassword123!",
        })
      ).status,
    ).toBe(200);
    expect((await post("/api/auth/profile", { name: "未登录" })).status).toBe(
      401,
    );
  });
  it("does not oversubscribe coupon issuance, allows one claim and freezes issued rules", async () => {
    seed();
    await run(() => marketingApi.saveCoupon({ ...coupon(), totalLimit: 1 }));
    const id = readDatabase(sql).coupons[0]!.id;
    const claimFor = (uid: string) =>
      context.run(
        { sql, user: { id: uid, role: "user", name: uid }, admin: null },
        () => marketingApi.claimCoupon(id),
      );
    const result = await Promise.allSettled([claimFor("u1"), claimFor("u2")]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(readDatabase(sql).couponClaims).toHaveLength(1);
    const original = readDatabase(sql).coupons[0]!;
    await expect(
      run(() => marketingApi.saveCoupon({ ...original, discount: 101 })),
    ).rejects.toThrow("只能启停");
    await run(() => marketingApi.saveCoupon({ ...original, active: false }));
    await expect(claimFor("u2")).rejects.toThrow("停用");
    await run(() => marketingApi.toggleCoupon(id));
    await expect(claimFor("u1")).rejects.toThrow("限领一次");
    expect(readDatabase(sql).coupons[0]!.discount).toBe(100);
  });
  it("enforces user/admin authorization and hides private promotion and review records", async () => {
    const a = cookieOf(
      await post("/api/auth/register", {
        username: "alice",
        name: "小艾",
        password: "AlicePass123!",
      }),
    );
    const b = cookieOf(
      await post("/api/auth/register", {
        username: "bobby",
        name: "小博",
        password: "BobbyPass123!",
      }),
    );
    expect(
      (await post("/api/actions/saveCoupon", { args: [coupon()] }, a)).status,
    ).toBe(401);
    expect(
      (await post("/api/actions/moderateReview", { args: ["x", true] }, a))
        .status,
    ).toBe(401);
    const db = readDatabase(sql),
      uid = db.users[0]!.id;
    db.coupons.push({ ...coupon(), id: "c" });
    const privatePurchase = privateOrder(db, uid, "private-order");
    db.couponClaims.push({
      id: "private-claim",
      userId: uid,
      couponId: "c",
      claimedAt: new Date().toISOString(),
      status: "available",
    });
    db.reviews.push({
      id: "private-review",
      userId: uid,
      productId: "p01",
      orderId: "private-order",
      orderItemId: privatePurchase.items[0]!.id,
      createdAt: new Date().toISOString(),
      rating: 5,
      content: "私有评价记录",
      deleted: true,
      hidden: false,
    });
    writeDatabase(sql, db);
    expect((await snapshot(a)).db.couponClaims).toHaveLength(1);
    for (const cookie of ["", b]) {
      const state = await snapshot(cookie);
      expect(state.db.couponClaims).toEqual([]);
      expect(state.db.reviews).toEqual([]);
      expect(state.db.checkoutQuotes).toEqual([]);
      expect(state.db.orderRequests).toEqual([]);
    }
    expect(
      (await post("/api/actions/deleteReview", { args: ["private-review"] }, b))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/actions/quoteCheckout",
          {
            args: [
              {
                source: {
                  type: "buyNow",
                  productId: "p01",
                  skuId: "p01-s1",
                  quantity: 1,
                },
                addressId: "forged",
                total: 1,
              },
            ],
          },
          a,
        )
      ).status,
    ).toBe(400);
  });
  it("refunds discounted quantities exactly once with remainder cents and excludes fully returned reviews", async () => {
    seed();
    const fixture = readDatabase(sql);
    fixture.products[0]!.skus[0]!.price = 101;
    writeDatabase(sql, fixture);
    await run(() => marketingApi.saveCoupon(coupon()));
    await run(() => marketingApi.claimCoupon(readDatabase(sql).coupons[0]!.id));
    const quote = await run(() =>
      commerceApi.quoteCheckout({
        source: {
          type: "buyNow",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 3,
        },
        addressId: "a1",
        couponClaimId: readDatabase(sql).couponClaims[0]!.id,
      }),
    );
    const orderId = await run(() =>
      commerceApi.createOrder({
        quoteId: quote.id,
        requestId: "refunded-review",
      }),
    );
    expect(quote.total).toBe(203);
    await run(() => commerceApi.payOrder(orderId));
    const line = readDatabase(sql).orders.find((o) => o.id === orderId)!
      .items[0]!;
    const review = {
      orderId,
      orderItemId: line.id,
      rating: 5,
      content: "<script>评价作为文本显示</script>",
    };
    await expect(run(() => marketingApi.submitReview(review))).rejects.toThrow(
      "已收货",
    );
    await run(() => commerceApi.shipOrder(orderId, "模拟物流", "TEST-OUT"));
    await run(() => commerceApi.confirmOrder(orderId));
    await run(() => marketingApi.submitReview(review));
    const publicBody = publicReviews(readDatabase(sql), "p01");
    expect(publicBody.items[0]!.displayName).toBe("林**");
    expect(publicBody.items[0]).not.toHaveProperty("userId");
    expect(publicBody.items[0]).not.toHaveProperty("orderId");
    expect(publicBody.averageRating).toBe(5);
    await expect(run(() => marketingApi.submitReview(review))).rejects.toThrow(
      "只能评价一次",
    );
    const reviewId = readDatabase(sql).reviews[0]!.id;
    await run(() => marketingApi.moderateReview(reviewId, true));
    expect(publicReviews(readDatabase(sql), "p01").total).toBe(0);
    await run(() => marketingApi.moderateReview(reviewId, false));
    const refunded: number[] = [];
    for (let i = 0; i < 3; i++) {
      await run(() =>
        commerceApi.requestAfterSale(orderId, "规格不合适", "按数量分批退货", [
          { orderItemId: line.id, quantity: 1 },
        ]),
      );
      const sale = readDatabase(sql).afterSales[0]!;
      expect(publicReviews(readDatabase(sql), "p01").total).toBe(1);
      refunded.push(sale.refundAmount);
      await run(() => commerceApi.processAfterSale(sale.id, "approve"));
      await expect(
        run(() => commerceApi.processAfterSale(sale.id, "receive")),
      ).rejects.toThrow("退货单号");
      await run(() =>
        commerceApi.submitReturn(sale.id, "模拟物流", `TEST-IN-${i}`),
      );
      await run(() => commerceApi.processAfterSale(sale.id, "receive"));
      await Promise.all([
        run(() => commerceApi.processAfterSale(sale.id, "refund")),
        run(() => commerceApi.processAfterSale(sale.id, "refund")),
      ]);
      expect(publicReviews(readDatabase(sql), "p01").total).toBe(
        i === 2 ? 0 : 1,
      );
    }
    expect(refunded).toEqual([67, 68, 68]);
    const db = readDatabase(sql),
      order = db.orders.find((o) => o.id === orderId)!;
    expect(order).toMatchObject({
      status: "refunded",
      total: 203,
      refundedAmount: 203,
    });
    expect(order.items[0]!.refundedQuantity).toBe(3);
    expect(
      db.ledger
        .filter((l) => l.reference === orderId && l.type === "refund")
        .reduce((n, l) => n + l.amount, 0),
    ).toBe(203);
    expect(db.couponClaims[0]!.status).toBe("used");
    expect(db.products[0]!.skus[0]!.stock).toBe(
      fixture.products[0]!.skus[0]!.stock - 3,
    );
    expect(db.returnInspections!.reduce((n, i) => n + i.quantity, 0)).toBe(3);
    const before = readDatabase(sql);
    await expect(
      run(() => marketingApi.moderateReview(reviewId, false)),
    ).rejects.toThrow("历史");
    expect(readDatabase(sql)).toEqual(before);
  });
  it("supports deletion, plaintext content, pagination and rating recalculation without identity leaks", () => {
    seed();
    const db = readDatabase(sql);
    const completed = db.orders.find((o) => o.status === "completed")!;
    const item = completed.items[0]!;
    for (let i = 0; i < 12; i++)
      db.reviews.push({
        id: `r${i}`,
        userId: completed.userId,
        orderId: completed.id,
        orderItemId: item.id,
        productId: item.productId,
        createdAt: new Date(Date.now() + i).toISOString(),
        content: "很好用的商品",
        rating: i < 6 ? 3 : 5,
        hidden: false,
        deleted: false,
      });
    const one = publicReviews(db, item.productId),
      two = publicReviews(db, item.productId, 99);
    expect(one.items).toHaveLength(10);
    expect(two.items).toHaveLength(2);
    expect(two.page).toBe(2);
    expect(one.averageRating).toBe(4);
    expect(Object.keys(one.items[0]!).sort()).toEqual([
      "content",
      "createdAt",
      "displayName",
      "id",
      "rating",
    ]);
    db.reviews[0]!.deleted = true;
    db.reviews[6]!.hidden = true;
    expect(publicReviews(db, item.productId).total).toBe(10);
  });
});
