import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createEdgeVex,
  reviewedEdgeImage,
  validateAdaptedEdge,
  validateEdgeImage,
  validateEdgeInputs,
} from "../../scripts/production-edge-vex.mjs";

// Recorded from the fixed image's real offline `caddy adapt` invocation.
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/production-edge-adapted.json", import.meta.url),
    "utf8",
  ),
);
const configPath = fileURLToPath(
  new URL("../../deploy/Caddyfile", import.meta.url),
);
const caddyfile = readFileSync(configPath);
const command = [
  "caddy",
  "run",
  "--config",
  "/etc/caddy/Caddyfile",
  "--adapter",
  "caddyfile",
];
const image = {
  RepoDigests: [reviewedEdgeImage.replace(":2.11.9-alpine", "")],
  Architecture: "amd64",
  Config: { Cmd: command },
};
function edge() {
  return {
    image: reviewedEdgeImage,
    environment: { DOMAIN: "shopmate.example", ACME_EMAIL: "ops@example.com" },
    volumes: [
      { target: "/data", type: "volume", source: "data" },
      { target: "/config", type: "volume", source: "config" },
      {
        target: "/srv/maintenance",
        type: "bind",
        source: "/synthetic",
        read_only: true,
      },
      {
        target: "/etc/caddy/Caddyfile",
        type: "bind",
        source: configPath,
        read_only: true,
      },
    ],
  };
}

it("accepts the recorded edge profile and binds only the reviewed CVEs to their exact subcomponents", () => {
  const { domain, email } = validateEdgeInputs(edge(), caddyfile, configPath);
  validateEdgeImage(image);
  const result = validateAdaptedEdge(fixture, domain, email);
  const vex = createEdgeVex(result, "2026-11-06T00:00:00Z");
  expect(vex.version).toBe(2);
  expect(vex.statements.map((entry) => entry.vulnerability.name)).toEqual([
    "CVE-2026-116587",
    "CVE-2026-78661",
  ]);
  expect(vex.statements[0]).toMatchObject({
    vulnerability: { name: "CVE-2026-116587" },
    status: "not_affected",
    justification: "vulnerable_code_not_in_execute_path",
    products: [
      {
        "@id": expect.stringContaining("@sha256:71d41"),
        subcomponents: [
          { "@id": "pkg:golang/github.com/go-jose/go-jose/v3@v3.0.5" },
        ],
      },
    ],
  });
  expect(vex.statements[1]).toMatchObject({
    vulnerability: {
      name: "CVE-2026-78661",
      aliases: ["GO-2026-6860", "GHSA-75pg-wvh3-34jr"],
    },
    status: "not_affected",
    justification: "vulnerable_code_not_in_execute_path",
    products: [
      {
        "@id": expect.stringContaining("@sha256:71d41"),
        subcomponents: [{ "@id": "pkg:golang/golang.org/x/net@v0.60.0" }],
      },
    ],
  });
  expect(JSON.stringify(vex)).not.toContain("CVE-2026-116585");
});

it("invalidates changed image, Caddyfile, startup command, mount or environment", () => {
  expect(() =>
    validateEdgeInputs(
      { ...edge(), image: "caddy:latest" },
      caddyfile,
      configPath,
    ),
  ).toThrow("image reference changed");
  expect(() =>
    validateEdgeInputs(
      edge(),
      Buffer.concat([caddyfile, Buffer.from("\n")]),
      configPath,
    ),
  ).toThrow("SHA256 changed");
  expect(() =>
    validateEdgeInputs(
      { ...edge(), command: [...command, "--resume"] },
      caddyfile,
      configPath,
    ),
  ).toThrow("--resume");
  expect(() =>
    validateEdgeInputs(
      { ...edge(), entrypoint: ["sh"] },
      caddyfile,
      configPath,
    ),
  ).toThrow("entrypoint");
  const writable = edge();
  writable.volumes[3].read_only = false;
  expect(() => validateEdgeInputs(writable, caddyfile, configPath)).toThrow(
    "read-only",
  );
  expect(() =>
    validateEdgeInputs(
      {
        ...edge(),
        environment: { ...edge().environment, CADDY_ADMIN: "0.0.0.0:2019" },
      },
      caddyfile,
      configPath,
    ),
  ).toThrow("environment");
  expect(() =>
    validateEdgeImage({
      ...image,
      RepoDigests: ["caddy@sha256:" + "0".repeat(64)],
    }),
  ).toThrow("digest");
  expect(() =>
    validateEdgeImage({ ...image, Config: { Cmd: [...command, "--resume"] } }),
  ).toThrow("default command");
});

it("rejects activated PKI, ACME server, admin, internal issuer and changes within allowed handlers", () => {
  for (const mutate of [
    (data: typeof fixture) => {
      data.apps.pki = {};
    },
    (data: typeof fixture) => {
      data.admin.disabled = false;
    },
    (data: typeof fixture) => {
      data.apps.http.servers.srv0.routes.push({
        handle: [{ handler: "acme_server" }],
      });
    },
    (data: typeof fixture) => {
      data.apps.http.servers.srv0.routes.push({
        handle: [{ handler: "templates" }],
      });
    },
    (data: typeof fixture) => {
      data.apps.tls.automation.policies[0].issuers.push({ module: "internal" });
    },
    (data: typeof fixture) => {
      data.apps.http.servers.srv0.listen = [":8443"];
    },
    (data: typeof fixture) => {
      data.apps.tls.automation.policies[0].issuers[0].ca =
        "https://unreviewed.example/directory";
    },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    expect(() =>
      validateAdaptedEdge(changed, "shopmate.example", "ops@example.com"),
    ).toThrow("requires reassessment");
  }
});
