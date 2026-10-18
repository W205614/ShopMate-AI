import { expect, it } from "vitest";
import { BoundedRequestMarker } from "../scripts/production-load-observer";

it("matches the proxy's response ID even when its log arrives before the response", () => {
  const marker = new BoundedRequestMarker(3),
    response = new Response("ok", {
      headers: { "X-Request-ID": "proxy-generated-id" },
    });
  marker.record("other-id");
  marker.record("proxy-generated-id");
  expect(marker.seen).toBe(false);
  expect(marker.expect(response.headers.get("X-Request-ID"))).toBe(true);
  expect(marker.seen).toBe(true);
  const later = new BoundedRequestMarker(3);
  expect(later.expect("later-proxy-id")).toBe(true);
  expect(later.seen).toBe(false);
  later.record("later-proxy-id");
  expect(later.seen).toBe(true);
});

it("bounds probe candidates, rejects invalid IDs, and retains a match after eviction", () => {
  const marker = new BoundedRequestMarker(2);
  marker.record("old");
  marker.record("new");
  marker.record("new");
  marker.record("latest");
  expect(marker.size).toBe(2);
  expect(marker.expect("old")).toBe(true);
  expect(marker.seen).toBe(false);
  expect(marker.expect(null)).toBe(false);
  expect(marker.expect("bad\nheader")).toBe(false);
  marker.record("bad\nheader");
  expect(marker.size).toBe(2);
  expect(marker.expect("new")).toBe(true);
  expect(marker.seen).toBe(true);
  marker.record("one");
  marker.record("two");
  expect(marker.size).toBe(2);
  expect(marker.seen).toBe(true);
  expect(() => new BoundedRequestMarker(Infinity)).toThrow();
});
