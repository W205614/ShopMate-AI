import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const reviewedCaddyfileSha256 =
  "bddf46e9a0552c4575da8c41e1b8c63535c960cec7151b193ee4668127a29e91";
const reviewedAdaptedSha256 =
  "3e5abcae89ae395efc2a2cec3ef2628c69acfe714a9a8006a99c107037941136";
const command = [
  "caddy",
  "run",
  "--config",
  "/etc/caddy/Caddyfile",
  "--adapter",
  "caddyfile",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = (message) => {
  throw new Error(`Production edge configuration check failed: ${message}`);
};

export function validateEdgeInputs(edge, caddyfile, configPath) {
  if (typeof edge.image !== "string" || !edge.image)
    fail("image reference is required");
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
  if (image.Architecture !== "amd64")
    fail("only the validated amd64 platform is supported");
  if (
    !same(image.Config.Cmd, command) ||
    (image.Config.Entrypoint != null && image.Config.Entrypoint.length !== 0)
  )
    fail("image command must explicitly select the reviewed config");
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

export function checkProductionEdge({
  envFile = resolve(root, ".env.production.example"),
  output,
} = {}) {
  if (!output) throw new Error("--output must name a new evidence file");
  const outputPath = resolve(output);
  const composePath = resolve(root, "deploy/compose.production.yaml");
  const configPath = resolve(root, "deploy/Caddyfile");
  const run = (args, env = process.env) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    readFileSync(configPath),
    configPath,
  );
  const imageRef = compose.services.edge.image;
  const [image] = JSON.parse(run(["image", "inspect", imageRef]));
  validateEdgeImage(image);
  const args = [
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
    imageRef,
  ];
  run([
    ...args,
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
  ]);
  const adapted = JSON.parse(
    run([
      ...args,
      "adapt",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ]),
  );
  const profile = validateAdaptedEdge(adapted, domain, email);
  const evidence = {
    ...profile,
    image: imageRef,
    imageId: image.Id,
    revision: image.Config.Labels?.["org.opencontainers.image.revision"],
    architecture: image.Architecture,
    caddyfileSha256: sha256(readFileSync(configPath)),
    composeSha256: sha256(readFileSync(composePath)),
    command: compose.services.edge.command ?? image.Config.Cmd,
    adminDisabled: true,
    networkDisabledDuringValidation: true,
    domain,
    email,
    adapted,
    checkedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + "\n", {
    flag: "wx",
  });
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index],
      value = process.argv[index + 1];
    if (!value || !["--env-file", "--output"].includes(flag))
      throw new Error(
        "Usage: production-edge-check.mjs [--env-file <file>] --output <new-file>",
      );
    options[flag === "--env-file" ? "envFile" : "output"] = value;
  }
  console.log(JSON.stringify(checkProductionEdge(options), null, 2));
}
