export interface CheckoutRecovery {
  userId: string;
  quoteId: string;
  requestId: string;
  checkoutPath: string;
  createdAt: number;
}
const key = (userId: string) => `shopmate:checkout:${userId}`;
export function checkoutRecoveryPath(path: string) {
  const url = new URL(path, "https://shopmate.invalid");
  if (
    !path.startsWith("/checkout") ||
    path.includes("\\") ||
    url.origin !== "https://shopmate.invalid" ||
    url.pathname !== "/checkout"
  )
    throw new Error("结算路径无效");
  const query = new URLSearchParams();
  for (const name of ["productId", "skuId", "quantity"]) {
    const value = url.searchParams.get(name);
    if (value !== null) query.set(name, value);
  }
  return `/checkout${query.size ? `?${query}` : ""}`;
}
function valid(value: CheckoutRecovery, userId: string, at: number) {
  if (
    !value ||
    !userId ||
    value.userId !== userId ||
    ![value.quoteId, value.requestId].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
    ) ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt > at ||
    at - value.createdAt >= 86400000
  )
    return false;
  try {
    return checkoutRecoveryPath(value.checkoutPath) === value.checkoutPath;
  } catch {
    return false;
  }
}
export function loadCheckoutRecovery(
  userId: string,
  at = Date.now(),
): CheckoutRecovery | null {
  const raw = sessionStorage.getItem(key(userId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as CheckoutRecovery;
    if (valid(value, userId, at)) return value;
  } catch {
    /* Corrupted local data never grants an order lookup. */
  }
  clearCheckoutRecovery(userId);
  return null;
}
export function saveCheckoutRecovery(value: CheckoutRecovery) {
  if (!valid(value, value.userId, Date.now()))
    throw new Error("结算恢复标识无效，请重新确认");
  // Only identifiers go into session storage, never address or quote contents.
  sessionStorage.setItem(
    key(value.userId),
    JSON.stringify({
      userId: value.userId,
      quoteId: value.quoteId,
      requestId: value.requestId,
      checkoutPath: value.checkoutPath,
      createdAt: value.createdAt,
    }),
  );
}
export function clearCheckoutRecovery(
  userId: string,
  expected?: CheckoutRecovery,
) {
  if (expected) {
    const raw = sessionStorage.getItem(key(userId));
    if (!raw) return;
    const current = JSON.parse(raw) as CheckoutRecovery;
    if (
      current.quoteId !== expected.quoteId ||
      current.requestId !== expected.requestId ||
      current.createdAt !== expected.createdAt
    )
      return;
  }
  sessionStorage.removeItem(key(userId));
}
