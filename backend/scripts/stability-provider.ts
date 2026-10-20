/** Deliberately failing provider, reachable only inside the isolated acceptance network. */
import { createServer } from "node:http";
if (
  process.env.SHOPMATE_ENV !== "acceptance" ||
  process.env.STABILITY_ALLOWED !== "1"
)
  throw new Error("Acceptance provider is disabled");
let calls = 0;
createServer((req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  req.resume();
  const mode = calls++ % 4;
  console.log(
    JSON.stringify({
      event: "provider_fault",
      mode: ["http429", "invalid_json", "timeout", "http503"][mode],
      call: calls,
    }),
  );
  if (mode === 2) {
    const timer = setTimeout(() => {
      if (!res.destroyed) {
        res.statusCode = 504;
        res.end();
      }
    }, 35000);
    req.once("close", () => {
      if (res.destroyed) clearTimeout(timer);
    });
    return;
  }
  res.statusCode = mode === 0 ? 429 : mode === 1 ? 200 : 503;
  res.setHeader("Content-Type", "application/json");
  res.end(
    mode === 1
      ? "not valid json"
      : JSON.stringify({ error: "acceptance fault" }),
  );
}).listen(3099, "0.0.0.0");
