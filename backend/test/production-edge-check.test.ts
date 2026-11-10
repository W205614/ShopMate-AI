import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  validateAdaptedEdge,
  validateEdgeImage,
  validateEdgeInputs,
} from "../../scripts/production-edge-check.mjs";

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
function edge() {
  return {
    image: "shopmate-ai-edge:local",
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

it("checks the real adapted production profile without issuing vulnerability exceptions", () => {
  const { domain, email } = validateEdgeInputs(edge(), caddyfile, configPath);
  validateEdgeImage({ Architecture: "amd64", Config: { Cmd: command } });
  expect(validateAdaptedEdge(fixture, domain, email).handlers).toEqual([
    "encode",
    "headers",
    "reverse_proxy",
    "static_response",
    "subroute",
  ]);
});

it("rejects changed config selection and writable or substituted configuration mounts", () => {
  expect(() =>
    validateEdgeInputs(
      { ...edge(), command: ["caddy", "run", "--resume"] },
      caddyfile,
      configPath,
    ),
  ).toThrow("explicit --config");
  expect(() =>
    validateEdgeInputs(
      { ...edge(), entrypoint: ["sh"] },
      caddyfile,
      configPath,
    ),
  ).toThrow("entrypoint");
  for (const change of [{ read_only: false }, { source: "/other/Caddyfile" }]) {
    const input = edge();
    Object.assign(input.volumes.at(-1)!, change);
    expect(() => validateEdgeInputs(input, caddyfile, configPath)).toThrow(
      "read-only bind",
    );
  }
  expect(() =>
    validateEdgeImage({
      Architecture: "amd64",
      Config: { Cmd: ["caddy", "run", "--resume"] },
    }),
  ).toThrow("explicitly select");
});

it("rejects admin, PKI, custom handlers and issuer expansion in effective configuration", () => {
  const inputs = [
    { ...structuredClone(fixture), admin: { listen: "0.0.0.0:2019" } },
    { ...structuredClone(fixture), apps: { ...fixture.apps, pki: {} } },
  ];
  for (const adapted of inputs)
    expect(() =>
      validateAdaptedEdge(adapted, "shopmate.example", "ops@example.com"),
    ).toThrow();
  const template = JSON.parse(
    JSON.stringify(fixture).replace('"reverse_proxy"', '"templates"'),
  );
  expect(() =>
    validateAdaptedEdge(template, "shopmate.example", "ops@example.com"),
  ).toThrow("handler");
  const internal = JSON.parse(
    JSON.stringify(fixture).replace('"acme"', '"internal"'),
  );
  expect(() =>
    validateAdaptedEdge(internal, "shopmate.example", "ops@example.com"),
  ).toThrow();
});
