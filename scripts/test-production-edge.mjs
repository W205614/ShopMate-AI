import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i],
    value = process.argv[i + 1];
  if (!value || !["--image", "--web-image", "--output"].includes(name))
    throw new Error(
      "Usage: test-production-edge.mjs --image <image> --web-image <image> --output <new-file>",
    );
  options[name.slice(2)] = value;
}
assert(
  options.image && options["web-image"] && options.output,
  "All three arguments are required",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
const fixtures = mkdtempSync(join(dirname(output), ".edge-smoke-"));
const maintenance = join(fixtures, "maintenance");
mkdirSync(maintenance);
const cert = join(fixtures, "cert.pem"),
  key = join(fixtures, "key.pem");
const opensslConfig = join(fixtures, "openssl.cnf");
writeFileSync(opensslConfig, "[req]\ndistinguished_name = dn\n[dn]\n", {
  flag: "wx",
});
execFileSync(
  process.env.OPENSSL_BIN || "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=shop.example.test",
    "-config",
    opensslConfig,
    "-addext",
    "subjectAltName=DNS:shop.example.test",
    "-keyout",
    key,
    "-out",
    cert,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const caddyfile = readFileSync(join(root, "deploy/Caddyfile"), "utf8");
assert(caddyfile.includes("{$DOMAIN} {"));
writeFileSync(
  join(fixtures, "Caddyfile"),
  caddyfile.replace(
    "{$DOMAIN} {",
    "{$DOMAIN} {\n\ttls /certs/cert.pem /certs/key.pem",
  ),
  { flag: "wx" },
);
writeFileSync(
  join(fixtures, "nginx.conf"),
  `events {}\nhttp { server { listen 80; location / { default_type application/json; return 200 '{"forwardedProto":"$http_x_forwarded_proto","padding":"${"x".repeat(2048)}"}'; } } }\n`,
  { flag: "wx" },
);
const project = `shopmate-edge-smoke-${randomUUID().slice(0, 8)}`;
const compose = {
  services: {
    web: {
      image: options["web-image"],
      volumes: [
        `${join(fixtures, "nginx.conf").replaceAll("\\", "/")}:/etc/nginx/nginx.conf:ro`,
      ],
    },
    edge: {
      image: options.image,
      environment: {
        DOMAIN: "shop.example.test",
        ACME_EMAIL: "ops@example.test",
      },
      volumes: [
        `${join(fixtures, "Caddyfile").replaceAll("\\", "/")}:/etc/caddy/Caddyfile:ro`,
        `${fixtures.replaceAll("\\", "/")}:/certs:ro`,
        `${maintenance.replaceAll("\\", "/")}:/srv/maintenance:ro`,
      ],
      tmpfs: ["/data", "/config"],
      depends_on: { web: { condition: "service_healthy" } },
    },
  },
  networks: { default: { internal: true } },
};
const composePath = join(fixtures, "compose.json");
writeFileSync(composePath, JSON.stringify(compose, null, 2), { flag: "wx" });
const docker = (args) =>
  execFileSync(
    "docker",
    ["compose", "-p", project, "-f", composePath, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
const results = [];
let failure;
try {
  docker([
    "up",
    "-d",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    "45",
  ]);
  const request = (path, encrypted = true, headers = {}) => {
    const port = encrypted ? 443 : 80;
    const args = [
      "exec",
      "-T",
      "edge",
      "curl",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "--compressed",
      "--dump-header",
      "-",
      "--resolve",
      `shop.example.test:${port}:127.0.0.1`,
    ];
    if (encrypted) args.push("--http2", "--cacert", "/certs/cert.pem");
    for (const [name, value] of Object.entries(headers))
      args.push("--header", `${name}: ${value}`);
    args.push(`${encrypted ? "https" : "http"}://shop.example.test${path}`);
    const raw = docker(args);
    const separator = raw.indexOf("\r\n\r\n");
    assert(separator >= 0, "curl response must include a header block");
    const lines = raw.slice(0, separator).split("\r\n");
    const status = /^HTTP\/([\d.]+) (\d{3})/.exec(lines.shift());
    assert(status, "curl response status must be valid");
    const responseHeaders = Object.fromEntries(
      lines.map((line) => {
        const colon = line.indexOf(":");
        assert(colon > 0, "curl response header must be valid");
        return [
          line.slice(0, colon).toLowerCase(),
          line.slice(colon + 1).trim(),
        ];
      }),
    );
    return {
      status: Number(status[2]),
      httpVersion: status[1],
      headers: responseHeaders,
      body: raw.slice(separator + 4),
    };
  };
  let ready;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      ready = await request("/");
      break;
    } catch (error) {
      if (attempt === 39) throw error;
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  assert.equal(ready.status, 200);
  assert.equal(ready.httpVersion, "2");
  assert.equal(JSON.parse(ready.body.toString()).forwardedProto, "https");
  assert.equal(ready.headers["strict-transport-security"], "max-age=31536000");
  results.push(
    "trusted local TLS with HTTP/2, proxy and HTTPS forwarded protocol",
    "HSTS header",
  );
  const redirect = await request("/some-path?x=1", false);
  assert.equal(redirect.status, 308);
  assert.equal(
    redirect.headers.location,
    "https://shop.example.test/some-path?x=1",
  );
  results.push("HTTP to HTTPS redirect preserves path and query");
  for (const path of ["/metrics", "/api/internal/probe"]) {
    assert.equal((await request(path)).status, 404);
    results.push(`blocked public path ${path}`);
  }
  const compressed = await request("/", true, { "Accept-Encoding": "gzip" });
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(JSON.parse(compressed.body).forwardedProto, "https");
  results.push("gzip response preserves proxied content");
  writeFileSync(join(maintenance, "active"), "synthetic maintenance", {
    flag: "wx",
  });
  const blocked = await request("/");
  assert.equal(blocked.status, 503);
  assert.match(blocked.body.toString(), /商城正在维护/);
  results.push("maintenance gate returns 503");
  renameSync(join(maintenance, "active"), join(maintenance, "completed"));
  assert.equal((await request("/")).status, 200);
  results.push("service resumes after maintenance marker is moved");
} catch (error) {
  failure = error;
} finally {
  try {
    writeFileSync(
      join(fixtures, "containers.log"),
      docker(["logs", "--no-color"]),
      { flag: "wx" },
    );
  } catch (error) {
    failure ??= error;
  }
  try {
    docker(["down"]);
  } catch (error) {
    failure ??= error;
  }
  const report = {
    ok: !failure,
    image: options.image,
    webImage: options["web-image"],
    sourceCaddyfile: "deploy/Caddyfile",
    fixtures,
    results,
    passed: results.length,
    boundary:
      "synthetic Nginx upstream; original production routes plus explicit test-only local certificate; internal Docker network; no public ACME or real business/provider calls",
    failure: failure?.message,
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
