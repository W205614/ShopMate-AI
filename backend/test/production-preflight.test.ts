import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostSecretPath,
  preflight,
  validateProductionSettings,
  validateRunningRelease,
} from "../../scripts/production-preflight.mjs";

function settings() {
  return {
    SHOP_MODE: "production",
    PUBLIC_URL: "https://shop.example.test",
    DOMAIN: "shop.example.test",
    ACME_EMAIL: "ops@example.test",
    COMPOSE_PROJECT_NAME: "shopmate-production-acceptance",
    VCS_REF: "a".repeat(40),
    API_IMAGE: "example.test/shopmate-api:release-a",
    WEB_IMAGE: "example.test/shopmate-web:release-a",
    CADDY_IMAGE: "caddy:2.11.9-alpine",
    SECRETS_PATH: "/etc/shopmate-acceptance/secrets",
    PRODUCTION_STATE_PATH: "/srv/shopmate-acceptance/runtime",
    BACKUP_PATH: "/srv/shopmate-acceptance/backups",
    ASSET_PATH: "/srv/shopmate-acceptance/assets",
    ENCRYPTION_KEY_FILE: "/run/secrets/key",
    MONITOR_TOKEN_FILE: "/run/secrets/monitor",
    ADMIN_PASSWORD_FILE: "/run/secrets/admin",
    COOKIE_SECURE: "true",
    PAYMENT_CHANNELS: "alipay_page",
    ALIPAY_APP_ID: "synthetic-app",
    ALIPAY_SELLER_ID: "synthetic-merchant",
    ALIPAY_PRIVATE_KEY_FILE: "/run/secrets/alipay-private",
    ALIPAY_PUBLIC_KEY_FILE: "/run/secrets/alipay-public",
    SMTP_HOST: "smtp.example.test",
    SMTP_FROM: "no-reply@example.test",
  };
}

describe("production release preflight", () => {
  it("checks enabled remote backup credentials for shared/dedicated buckets and ignores disabled leftover settings", () => {
    const enabled = {
      ...settings(),
      ASSET_STORAGE: "local",
      BACKUP_S3_ENABLED: "true",
      S3_BUCKET: "shared-backups",
    };
    expect(validateProductionSettings(enabled)).toContain(
      "S3_REGION is required",
    );
    const credentials = {
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "synthetic-id",
      S3_SECRET_ACCESS_KEY: "synthetic-secret",
    };
    expect(validateProductionSettings({ ...enabled, ...credentials })).toEqual(
      [],
    );
    expect(
      validateProductionSettings({
        ...enabled,
        ...credentials,
        S3_BUCKET: "",
        BACKUP_S3_BUCKET: "dedicated-backups",
      }),
    ).toEqual([]);
    expect(
      validateProductionSettings({ ...enabled, ...credentials, S3_BUCKET: "" }),
    ).toContain("Remote backup requires BACKUP_S3_BUCKET or S3_BUCKET");
    expect(
      validateProductionSettings({
        ...settings(),
        ASSET_STORAGE: "local",
        BACKUP_S3_ENABLED: "false",
        BACKUP_S3_BUCKET: "leftover",
      }),
    ).toEqual([]);
  });
  it("accepts an explicit release config while reporting that real services were not tested", () => {
    const env = settings();
    expect(validateProductionSettings(env)).toEqual([]);
    const directory = mkdtempSync(join(tmpdir(), "shopmate-preflight-"));
    const path = join(directory, "acceptance.env");
    writeFileSync(
      path,
      Object.entries(env)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n"),
    );
    expect(preflight(path, { skipFiles: true, skipDocker: true })).toEqual({
      ok: true,
      problems: [],
      checks: { files: false, imagesAndCompose: false, runtime: false },
      externalServicesTested: false,
    });
    expect(
      preflight(path, {
        skipFiles: true,
        skipDocker: true,
        runtime: true,
      }).problems,
    ).toContain("Runtime verification requires Docker checks");
  });
  it("rejects HTTP origins, origin/domain mismatch, demo reset and missing verification channels", () => {
    const env = {
      ...settings(),
      PUBLIC_URL: "http://other.example.test",
      COOKIE_SECURE: "false",
      SMTP_HOST: "",
      ALLOW_DEMO_RESET: "true",
    };
    const problems = validateProductionSettings(env);
    expect(problems).toContain(
      "PUBLIC_URL must be the HTTPS origin of DOMAIN (no trailing slash)",
    );
    expect(problems).toContain("Enable SMTP email or verification SMS");
    expect(problems).toContain("ALLOW_DEMO_RESET must be false in production");
    expect(problems).toContain("COOKIE_SECURE must be true in production");
  });
  it("requires enabled provider credentials and does not expose their values", () => {
    const problems = validateProductionSettings({
      ...settings(),
      PAYMENT_CHANNELS: "wechat_native",
      WECHAT_APP_ID: "private-test-app",
    });
    expect(problems).toContain("WECHAT_MCH_ID is required");
    expect(problems.join("\n")).not.toContain("private-test-app");
  });
  it("rejects secret path escapes and arbitrary files outside the secret mount", () => {
    expect(() => hostSecretPath(settings(), "/etc/passwd")).toThrow(
      "Secret file must be under /run/secrets/",
    );
    expect(() => hostSecretPath(settings(), "/run/secrets/../other")).toThrow(
      "Secret path escapes SECRETS_PATH",
    );
    expect(hostSecretPath(settings(), "/run/secrets/alipay-private")).toMatch(
      /alipay-private$/,
    );
  });
  it("reserves the trusted edge address outside the dynamic allocation pool", () => {
    expect(
      validateProductionSettings({ ...settings(), CADDY_IP: "10.254.86.130" }),
    ).toContain(
      "CADDY_IP must be inside PROXY_SUBNET and outside its contained PROXY_DYNAMIC_RANGE",
    );
    expect(
      validateProductionSettings({
        ...settings(),
        PROXY_SUBNET: "10.254.87.0/24",
      }),
    ).toContain(
      "CADDY_IP must be inside PROXY_SUBNET and outside its contained PROXY_DYNAMIC_RANGE",
    );
    expect(
      validateProductionSettings({
        ...settings(),
        PROXY_SUBNET: "bad-network",
      }),
    ).toContain(
      "Proxy subnet, dynamic range and Caddy address must be valid IPv4 settings",
    );
  });
  it("requires both SMS templates when the shared SMS capability is enabled", () => {
    expect(
      validateProductionSettings({ ...settings(), SMS_ENABLED: "true" }),
    ).toContain("ALIYUN_SMS_TEMPLATE_TRANSACTION is required");
  });
  it("checks actual runtime image identity, revision, mode and health before resuming", () => {
    const env = settings();
    const images = { api: { Id: "sha256:api" }, web: { Id: "sha256:web" } };
    const make = (image: string) => ({
      Image: image,
      Config: {
        Labels: { "org.opencontainers.image.revision": env.VCS_REF },
        Env: ["SHOP_MODE=production"],
      },
      State: { Running: true, Health: { Status: "healthy" } },
    });
    const containers = {
      api: [make(images.api.Id)],
      web: [make(images.web.Id)],
    };
    expect(validateRunningRelease(env, images, containers)).toEqual([]);
    const old = structuredClone(containers);
    old.api[0]!.Image = "sha256:previous-build-same-revision";
    expect(validateRunningRelease(env, images, old)).toContain(
      "api running image does not match the release image",
    );
    const stale = structuredClone(containers);
    stale.web[0]!.Config.Labels["org.opencontainers.image.revision"] =
      "b".repeat(40);
    expect(validateRunningRelease(env, images, stale)).toContain(
      "web running revision does not match VCS_REF",
    );
    const stopped = structuredClone(containers);
    stopped.api[0]!.State.Running = false;
    expect(validateRunningRelease(env, images, stopped)).toContain(
      "api container must be running and healthy",
    );
    const unhealthy = structuredClone(containers);
    unhealthy.web[0]!.State.Health.Status = "starting";
    expect(validateRunningRelease(env, images, unhealthy)).toContain(
      "web container must be running and healthy",
    );
    const demo = structuredClone(containers);
    demo.api[0]!.Config.Env = ["SHOP_MODE=demo"];
    expect(validateRunningRelease(env, images, demo)).toContain(
      "api running mode must be production",
    );
    expect(
      validateRunningRelease(env, images, { ...containers, api: [] }),
    ).toContain("Expected exactly one api container");
    expect(
      validateRunningRelease(env, images, {
        ...containers,
        web: [...containers.web, ...containers.web],
      }),
    ).toContain("Expected exactly one web container");
  });
});
