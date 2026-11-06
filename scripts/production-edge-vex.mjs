import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const reviewedEdgeImage =
  "caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3";
export const reviewedCaddyfileSha256 =
  "bddf46e9a0552c4575da8c41e1b8c63535c960cec7151b193ee4668127a29e91";
const reviewedAdaptedSha256 =
  "3e5abcae89ae395efc2a2cec3ef2628c69acfe714a9a8006a99c107037941136";
const reviewedComposeSha256 =
  "927d0b198676c0bf2e5b4c2446773e397e2c38ee3b8f364eac783b8256406b61";
const command = [
  "caddy",
  "run",
  "--config",
  "/etc/caddy/Caddyfile",
  "--adapter",
  "caddyfile",
];
const digest = reviewedEdgeImage.split("@")[1];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = (message) => {
  throw new Error(`Edge VEX requires reassessment: ${message}`);
};

export function validateEdgeInputs(edge, caddyfile, configPath) {
  if (edge.image !== reviewedEdgeImage) fail("image reference changed");
  if (sha256(caddyfile) !== reviewedCaddyfileSha256)
    fail("Caddyfile SHA256 changed");
  if (edge.entrypoint != null) fail("entrypoint override is not reviewed");
  if (edge.command != null && !same(edge.command, command))
    fail("command override must retain explicit --config without --resume");
  const environment = edge.environment ?? {};
  if (!same(Object.keys(environment).sort(), ["ACME_EMAIL", "DOMAIN"]))
    fail("edge environment changed");
  const { DOMAIN: domain, ACME_EMAIL: email } = environment;
  if (
    typeof domain !== "string" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  )
    fail("a public DNS hostname is required");
  if (
    typeof email !== "string" ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(email)
  )
    fail("ACME email is outside the reviewed argument format");
  const mounts = edge.volumes ?? [];
  if (
    !same(mounts.map((mount) => mount.target).sort(), [
      "/config",
      "/data",
      "/etc/caddy/Caddyfile",
      "/srv/maintenance",
    ])
  )
    fail("edge mounts changed");
  const file = mounts.find((mount) => mount.target === "/etc/caddy/Caddyfile");
  if (
    file.type !== "bind" ||
    file.read_only !== true ||
    resolve(file.source) !== resolve(configPath)
  )
    fail("Caddyfile must be the reviewed read-only bind mount");
  return { domain, email };
}

export function validateEdgeImage(image) {
  if (
    !image.RepoDigests?.some((reference) => reference === `caddy@${digest}`) ||
    image.Architecture !== "amd64"
  )
    fail(
      "local image digest or architecture does not match the reviewed image",
    );
  if (
    !same(image.Config.Cmd, command) ||
    (image.Config.Entrypoint != null && image.Config.Entrypoint.length !== 0)
  )
    fail("image default command must explicitly select the reviewed config");
}

export function validateAdaptedEdge(adapted, domain, email) {
  if (!same(Object.keys(adapted.apps ?? {}).sort(), ["http", "tls"]))
    fail("only HTTP and TLS apps are reviewed");
  if (!same(adapted.admin, { disabled: true }))
    fail("admin API must remain disabled");
  const handlers = new Set();
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      if ("handler" in value) {
        if (
          ![
            "encode",
            "headers",
            "reverse_proxy",
            "static_response",
            "subroute",
          ].includes(value.handler)
        )
          fail(`HTTP handler ${value.handler} is not reviewed`);
        handlers.add(value.handler);
      }
      if ("module" in value && value.module !== "acme")
        fail(`module ${value.module} is not reviewed`);
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, normalize(value[key])]),
      );
    }
    return value === domain ? "<domain>" : value === email ? "<email>" : value;
  };
  const normalizedHash = sha256(JSON.stringify(normalize(adapted)));
  if (normalizedHash !== reviewedAdaptedSha256)
    fail(
      "effective configuration differs from the reviewed routes and issuers",
    );
  return { handlers: [...handlers].sort(), normalizedHash };
}

export function createEdgeVex(evidence, timestamp = new Date().toISOString()) {
  // OCI/package identifiers cannot express configuration applicability. This file
  // is emitted only by the guard, never distributed as a static image-wide VEX.
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": `urn:shopmate:edge-vex:${reviewedCaddyfileSha256}`,
    author: "ShopMate-AI project maintainers",
    role: "Project configuration assessor; not an upstream supplier statement",
    timestamp,
    version: 1,
    statements: [
      {
        vulnerability: {
          name: "CVE-2026-116587",
          "@id":
            "https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q",
          aliases: ["GHSA-mgcc-cww5-fp2q"],
        },
        products: [
          {
            "@id": `pkg:oci/caddy@${digest}?arch=amd64&repository_url=index.docker.io%2Flibrary%2Fcaddy`,
            subcomponents: [
              {
                "@id": "pkg:golang/github.com/go-jose/go-jose/v3@v3.0.5",
              },
            ],
          },
        ],
        status: "not_affected",
        justification: "vulnerable_code_not_in_execute_path",
        impact_statement: `Applies only to the ShopMate edge profile verified by production-edge-vex.mjs: image ${reviewedEdgeImage}, Caddyfile SHA256 ${reviewedCaddyfileSha256}, effective configuration SHA256 ${evidence.normalizedHash}, explicit config command, admin disabled, only reviewed HTTP/TLS handlers and public ACME client issuers. The embedded smallstep ACME server/JWS-to-private-JWK parsing path is not activated. This is not a patched component or an image-wide assertion; do not reuse with other configurations. See docs/security/production-edge-vex.md.`,
      },
    ],
  };
}

export function guardEdgeVex({
  envFile = resolve(root, ".env.production.example"),
  output,
}) {
  if (!output) throw new Error("--output must name a new temporary VEX file");
  const outputPath = resolve(output);
  const targets = [
    outputPath,
    outputPath + ".evidence.json",
    outputPath + ".adapted.json",
  ];
  if (targets.some(existsSync))
    throw new Error("VEX output/evidence already exists; use a new directory");
  const run = (args, env = process.env) =>
    execFileSync("docker", args, {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const composePath = resolve(root, "deploy/compose.production.yaml");
  const configPath = resolve(root, "deploy/Caddyfile");
  if (sha256(readFileSync(composePath)) !== reviewedComposeSha256)
    fail("production Compose SHA256 changed");
  const caddyfile = readFileSync(configPath);
  const compose = JSON.parse(
    run(
      [
        "compose",
        "--env-file",
        resolve(envFile),
        "-f",
        composePath,
        "config",
        "--format",
        "json",
      ],
      { ...process.env, PRODUCTION_ENV_FILE: resolve(envFile) },
    ),
  );
  const { domain, email } = validateEdgeInputs(
    compose.services.edge,
    caddyfile,
    configPath,
  );
  const [image] = JSON.parse(run(["image", "inspect", reviewedEdgeImage]));
  validateEdgeImage(image);
  const adapted = JSON.parse(
    run([
      "run",
      "--rm",
      "--pull",
      "never",
      "--read-only",
      "--network",
      "none",
      "--entrypoint",
      "caddy",
      "-e",
      `DOMAIN=${domain}`,
      "-e",
      `ACME_EMAIL=${email}`,
      "--mount",
      `type=bind,source=${configPath},target=/etc/caddy/Caddyfile,readonly`,
      reviewedEdgeImage,
      "adapt",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ]),
  );
  const profile = validateAdaptedEdge(adapted, domain, email);
  if (sha256(readFileSync(configPath)) !== reviewedCaddyfileSha256)
    fail("Caddyfile changed during validation");
  const evidence = {
    ...profile,
    image: reviewedEdgeImage,
    architecture: image.Architecture,
    caddyfileSha256: reviewedCaddyfileSha256,
    composeSha256: sha256(readFileSync(composePath)),
    apps: Object.keys(adapted.apps).sort(),
    adminDisabled: true,
    command: compose.services.edge.command ?? image.Config.Cmd,
    networkDisabledDuringAdaptation: true,
    domain,
    email,
    assessedAt: new Date().toISOString(),
  };
  const vex = createEdgeVex(evidence, evidence.assessedAt);
  mkdirSync(dirname(outputPath), { recursive: true });
  for (const [path, value] of [
    [outputPath + ".evidence.json", evidence],
    [outputPath + ".adapted.json", adapted],
    [outputPath, vex],
  ])
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  return { output: outputPath, ...evidence };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index],
        value = process.argv[index + 1];
      if (!value || !["--env-file", "--output"].includes(flag))
        throw new Error(
          "Usage: node scripts/production-edge-vex.mjs [--env-file <file>] --output <new-temporary-file>",
        );
      options[flag === "--env-file" ? "envFile" : "output"] = value;
    }
    console.log(JSON.stringify(guardEdgeVex(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
