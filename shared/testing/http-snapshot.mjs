/** Test/acceptance evidence assembled through bounded public APIs; never a server-side full-state escape hatch. */
export async function readHttpSnapshot(getJson, role = "user") {
  const snapshot = await getJson(`/api/bootstrap?role=${role}`);
  const db = snapshot.db;
  const publicCollections = [
    "products",
    "categories",
    "coupons",
    "faqs",
    "promotions",
  ];
  const ownCollections = [
    "users",
    "carts",
    "addresses",
    "orders",
    "afterSales",
    "conversations",
    "couponClaims",
    "reviews",
    "pointsEntries",
    "notifications",
  ];
  const adminCollections = [
    "users",
    "orders",
    "afterSales",
    "conversations",
    "couponClaims",
    "reviews",
    "pointsEntries",
    "inventory",
    "ledger",
    "shippingRules",
    "suppliers",
    "purchaseOrders",
    "returnInspections",
    "auditEntries",
  ];
  const admin = role === "admin" && snapshot.sessions.admin;
  const collections = [
    ...publicCollections,
    ...(admin
      ? adminCollections
      : snapshot.sessions.user
        ? ownCollections
        : []),
  ];
  for (const collection of collections) {
    const items = [];
    for (let page = 1; ; page++) {
      const result = await getJson(
        `/api/collections/${collection}?role=${admin ? "admin" : "user"}&pageSize=100&page=${page}`,
      );
      items.push(...result.items);
      if (page >= result.pages) break;
    }
    db[collection] = items;
  }
  return snapshot;
}
