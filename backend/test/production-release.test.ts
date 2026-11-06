import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const posix = (path: string) =>
  path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function release(
  options: {
    resume?: boolean;
    exists?: boolean;
    container?: boolean;
    failRuntime?: boolean;
    failBackup?: boolean;
    marker?: string;
    badHealth?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "shopmate-release-protocol-"));
  const bin = join(directory, "bin"),
    state = join(directory, "state"),
    trace = join(directory, "trace.txt");
  mkdirSync(bin);
  mkdirSync(join(state, "maintenance"), { recursive: true });
  const revision = "a".repeat(40),
    marker = join(state, "maintenance/active");
  if (options.resume) writeFileSync(marker, options.marker ?? revision);
  writeFileSync(trace, "");
  const program = (name: string, body: string) =>
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
      { mode: 0o700 },
    );
  program(
    "node",
    `if [[ "$1" == *production-preflight.mjs ]]; then
  printf 'preflight %s\\n' "$*" >> "$RELEASE_FIXTURE_TRACE"
  if [[ "$*" == *--runtime* && "$RELEASE_FIXTURE_RUNTIME_FAIL" == 1 ]]; then exit 1; fi
  printf '{"ok":true}\\n'; exit 0
fi
exec ${quote(process.execPath.replaceAll("\\", "/"))} "$@"`,
  );
  program(
    "docker",
    `printf 'docker %s ip=%s\\n' "$*" "$CADDY_IP" >> "$RELEASE_FIXTURE_TRACE"
if [[ "$1 $2" == 'image inspect' ]]; then exit 0; fi
if [[ "$*" == *' ps -a -q api' ]]; then
  if [[ "$RELEASE_FIXTURE_CONTAINER" == 1 ]]; then printf 'stopped-api\\n'; fi; exit 0
fi
if [[ "$*" == *existsSync* ]]; then printf '%s' "$RELEASE_FIXTURE_DATABASE"; exit 0; fi
if [[ "$*" == *backup-local* ]]; then
  if [[ "$RELEASE_FIXTURE_BACKUP_FAIL" == 1 ]]; then exit 1; fi
  printf '{"snapshot":"synthetic"}\\n'; exit 0
fi
if [[ "$*" == *'src/maintenance.ts inspect'* || "$*" == *' stop -t 25 api' || "$*" == *' up -d '* || "$*" == *' exec -T api '* ]]; then exit 0; fi
printf 'Unexpected Docker protocol command\\n' >&2; exit 96`,
  );
  program(
    "curl",
    `printf 'curl maintenance=%s\\n' "$([[ -f "$RELEASE_FIXTURE_STATE/maintenance/active" ]] && printf active || printf absent)" >> "$RELEASE_FIXTURE_TRACE"
if [[ "$RELEASE_FIXTURE_BAD_HEALTH" == 1 ]]; then printf '<html>unexpected proxy page</html>'; else printf '{"status":"ok"}'; fi`,
  );
  const envFile = join(directory, "production.env");
  const config = {
    API_IMAGE: "example.test/api:release",
    WEB_IMAGE: "example.test/web:release",
    CADDY_IMAGE: "example.test/edge:release",
    VCS_REF: revision,
    PUBLIC_URL: "https://shop.example.test",
    DOMAIN: "shop.example.test",
    ACME_EMAIL: "ops@example.test",
    COMPOSE_PROJECT_NAME: "shopmate-release-protocol",
    PRODUCTION_STATE_PATH: posix(state),
    SECRETS_PATH: "/synthetic/secrets",
    BACKUP_PATH: "/synthetic/backups",
    ASSET_PATH: "/synthetic/assets",
    CADDY_IP: "10.254.86.2",
  };
  writeFileSync(
    envFile,
    Object.entries(config)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  );
  const result = spawnSync(
    bash,
    [
      "-c",
      'export PATH="$RELEASE_FIXTURE_PATH"; [[ "$(command -v docker)" == "$RELEASE_FIXTURE_BIN/docker" && "$(command -v curl)" == "$RELEASE_FIXTURE_BIN/curl" ]] || exit 97; source "$RELEASE_FIXTURE_SCRIPT" "$@"',
      "release-fixture",
      posix(envFile),
      ...(options.resume ? ["--resume"] : []),
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        PATH:
          process.platform === "win32"
            ? `${bin};C:/Program Files/Git/usr/bin;C:/Program Files/Git/bin`
            : `${bin}:/usr/bin:/bin`,
        RELEASE_FIXTURE_PATH: `${posix(bin)}:/usr/bin:/bin`,
        RELEASE_FIXTURE_BIN: posix(bin),
        RELEASE_FIXTURE_SCRIPT: posix(
          resolve("../scripts/production-release.sh"),
        ),
        CADDY_IP: "203.0.113.66",
        RELEASE_FIXTURE_TRACE: posix(trace),
        RELEASE_FIXTURE_STATE: posix(state),
        RELEASE_FIXTURE_DATABASE: options.exists === false ? "new" : "existing",
        RELEASE_FIXTURE_CONTAINER: options.container === false ? "0" : "1",
        RELEASE_FIXTURE_RUNTIME_FAIL: options.failRuntime ? "1" : "0",
        RELEASE_FIXTURE_BACKUP_FAIL: options.failBackup ? "1" : "0",
        RELEASE_FIXTURE_BAD_HEALTH: options.badHealth ? "1" : "0",
      },
    },
  );
  if (result.error) throw result.error;
  return {
    ...result,
    trace: readFileSync(trace, "utf8"),
    active: existsSync(marker),
  };
}

describe("production release script against isolated command protocols", () => {
  it("backs up stopped instances before startup and uses the checked proxy setting", () => {
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toContain("ps -a -q api");
    expect(result.trace).toContain("ip=10.254.86.2");
    expect(result.trace).not.toContain("ip=203.0.113.66");
    expect(result.trace.indexOf("backup-local")).toBeLessThan(
      result.trace.indexOf("stop -t 25 api"),
    );
    expect(result.trace.indexOf("stop -t 25 api")).toBeLessThan(
      result.trace.indexOf("up -d"),
    );
    expect(result.trace).toContain("--runtime");
    expect(result.trace).toContain("curl maintenance=absent");
    expect(result.active).toBe(false);
  }, 30000);
  it("backs up retained database data even without an old container", () => {
    const result = release({ container: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toContain("backup-local");
    expect(result.trace).not.toContain("stop -t 25 api");
  }, 30000);
  it("keeps maintenance and never starts the new API when snapshot creation fails", () => {
    const result = release({ failBackup: true });
    expect(result.status).not.toBe(0);
    expect(result.trace).not.toContain("up -d");
    expect(result.trace).not.toContain("stop -t 25 api");
    expect(result.active).toBe(true);
  }, 30000);
  it("requires runtime verification before resuming and retains maintenance on rejection", () => {
    const result = release({ resume: true, failRuntime: true });
    expect(result.status).not.toBe(0);
    expect(result.trace).toContain("--runtime");
    expect(result.trace).not.toContain("curl maintenance=absent");
    expect(result.trace).not.toContain("up -d");
    expect(result.active).toBe(true);
  }, 30000);
  it("refuses another revision's maintenance marker", () => {
    const wrong = release({ resume: true, marker: "b".repeat(40) });
    expect(wrong.status).not.toBe(0);
    expect(wrong.active).toBe(true);
  }, 30000);
  it("restores maintenance for invalid public health JSON", () => {
    const invalid = release({ resume: true, badHealth: true });
    expect(invalid.status).not.toBe(0);
    expect(invalid.trace).toContain("--runtime");
    expect(invalid.active).toBe(true);
  }, 30000);
  it("does not manufacture a pre-upgrade backup for a fresh empty store", () => {
    const result = release({ exists: false, container: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).not.toContain("backup-local");
    expect(result.active).toBe(false);
  }, 30000);
});
