/** Verify the built Web/API boundary without credentials or business writes. */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

const base = new URL(process.env.SECURITY_BASE_URL ?? "http://127.0.0.1:18087");
assert.ok(["127.0.0.1", "localhost"].includes(base.hostname) && base.protocol === "http:", "Use an isolated local deployment");
assert.notEqual(base.port, "18086", "Do not run acceptance against the daily deployment");
const get = (path, options) => fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(10000), redirect: "error" });
const html = await (await get("/")).text();
const asset = html.match(/src="([^\"]+\.js)"/)?.[1];
assert.ok(asset, "The production entry script must exist");
const cases = [];
for (const path of ["/", "/index.html", asset, "/images/p01.jpg", "/assets/missing-security-check.js", "/api/missing-security-check"]) {
  const response = await get(path);
  for (const [name, expected] of Object.entries({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": "frame-ancestors 'none'",
  })) assert.equal(response.headers.get(name), expected, `${path}: ${name}`);
  assert.equal(response.status, path.includes("missing-security-check") ? 404 : 200, path);
  await response.body?.cancel();
  cases.push({ path, status: response.status });
}
const headers = { "Content-Type": "application/json", "X-ShopMate-Request": "1" };
const rejected = await get("/api/auth/logout", {
  method: "POST", headers: { ...headers, "Content-Encoding": "gzip" },
  body: Buffer.concat([gzipSync('{"role":"user"}'), Buffer.from("trailing")]),
});
assert.equal(rejected.status, 415);
assert.equal((await rejected.json()).code, "UNSUPPORTED_CONTENT_ENCODING");
const health = await get("/api/health");
assert.equal(health.status, 200);
await health.body?.cancel();
const plain = await get("/api/auth/logout", { method: "POST", headers, body: '{"role":"user"}' });
assert.equal(plain.status, 200);
assert.deepEqual(await plain.json(), { ok: true });
console.log(JSON.stringify({ securityHeaders: cases, compressedRejection: 415, healthyAfterRejection: true, ordinaryJson: true }));
