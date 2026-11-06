import { readFileSync, statSync, accessSync, constants } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

function ipv4(value) {
  if (isIP(value) !== 4) throw new Error("Invalid IPv4 address");
  return value
    .split(".")
    .reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}
function cidr(value) {
  const [address, bits, extra] = value.split("/");
  if (extra !== undefined || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(bits ?? ""))
    throw new Error("Invalid IPv4 CIDR");
  const prefix = Number(bits),
    network = ipv4(address),
    mask = (0xffffffffn << BigInt(32 - prefix)) & 0xffffffffn;
  if ((network & mask) !== network)
    throw new Error("CIDR must name its network address");
  return { network, mask, prefix };
}

export function validateProductionSettings(env) {
  const problems = [];
  const need = (name) => {
    if (!env[name]?.trim()) problems.push(`${name} is required`);
  };
  if (env.SHOP_MODE !== "production")
    problems.push("SHOP_MODE must be production");
  for (const name of [
    "PUBLIC_URL",
    "DOMAIN",
    "ACME_EMAIL",
    "COMPOSE_PROJECT_NAME",
    "VCS_REF",
    "API_IMAGE",
    "WEB_IMAGE",
    "CADDY_IMAGE",
    "SECRETS_PATH",
    "PRODUCTION_STATE_PATH",
    "BACKUP_PATH",
    "ASSET_PATH",
    "ENCRYPTION_KEY_FILE",
    "MONITOR_TOKEN_FILE",
    "ADMIN_PASSWORD_FILE",
  ])
    need(name);
  try {
    const url = new URL(env.PUBLIC_URL);
    if (
      url.protocol !== "https:" ||
      url.origin !== env.PUBLIC_URL ||
      url.hostname !== env.DOMAIN
    )
      problems.push(
        "PUBLIC_URL must be the HTTPS origin of DOMAIN (no trailing slash)",
      );
  } catch {
    problems.push("PUBLIC_URL is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(env.VCS_REF ?? ""))
    problems.push("VCS_REF must be a full commit SHA");
  if (env.COOKIE_SECURE !== "true")
    problems.push("COOKIE_SECURE must be true in production");
  for (const name of ["API_IMAGE", "WEB_IMAGE"])
    if (!env[name] || /(?:REPLACE|your-account|:latest$)/.test(env[name]))
      problems.push(`${name} must identify a validated release image`);
  for (const name of [
    "SECRETS_PATH",
    "PRODUCTION_STATE_PATH",
    "BACKUP_PATH",
    "ASSET_PATH",
  ])
    if (!env[name]?.startsWith("/") || env[name] === "/")
      problems.push(`${name} must be an absolute Linux directory other than /`);
  try {
    const subnet = cidr(env.PROXY_SUBNET ?? "10.254.86.0/24"),
      dynamic = cidr(env.PROXY_DYNAMIC_RANGE ?? "10.254.86.128/25"),
      edge = ipv4(env.CADDY_IP ?? "10.254.86.2");
    if (
      dynamic.prefix < subnet.prefix ||
      (dynamic.network & subnet.mask) !== subnet.network ||
      (edge & subnet.mask) !== subnet.network ||
      (edge & dynamic.mask) === dynamic.network
    )
      problems.push(
        "CADDY_IP must be inside PROXY_SUBNET and outside its contained PROXY_DYNAMIC_RANGE",
      );
  } catch {
    problems.push(
      "Proxy subnet, dynamic range and Caddy address must be valid IPv4 settings",
    );
  }
  const channels = (env.PAYMENT_CHANNELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const supported = ["wechat_native", "wechat_h5", "alipay_page", "alipay_wap"];
  if (!channels.length || channels.some((value) => !supported.includes(value)))
    problems.push("PAYMENT_CHANNELS must contain supported payment channels");
  if (channels.some((value) => value.startsWith("wechat_")))
    for (const name of [
      "WECHAT_APP_ID",
      "WECHAT_MCH_ID",
      "WECHAT_MERCHANT_SERIAL",
      "WECHAT_PRIVATE_KEY_FILE",
      "WECHAT_PUBLIC_KEY_ID",
      "WECHAT_PUBLIC_KEY_FILE",
      "WECHAT_API_V3_KEY_FILE",
    ])
      need(name);
  if (channels.some((value) => value.startsWith("alipay_")))
    for (const name of [
      "ALIPAY_APP_ID",
      "ALIPAY_SELLER_ID",
      "ALIPAY_PRIVATE_KEY_FILE",
      "ALIPAY_PUBLIC_KEY_FILE",
    ])
      need(name);
  if (!env.SMTP_HOST && env.SMS_ENABLED !== "true")
    problems.push("Enable SMTP email or verification SMS");
  if (env.SMTP_HOST) {
    need("SMTP_FROM");
    if (!!env.SMTP_USERNAME !== !!env.SMTP_PASSWORD)
      problems.push(
        "SMTP_USERNAME and SMTP_PASSWORD must be configured together",
      );
  }
  if (env.SMS_ENABLED === "true")
    for (const name of [
      "ALIYUN_ACCESS_KEY_ID",
      "ALIYUN_ACCESS_KEY_SECRET",
      "ALIYUN_SMS_SIGN_NAME",
      "ALIYUN_SMS_TEMPLATE_VERIFICATION",
      "ALIYUN_SMS_TEMPLATE_TRANSACTION",
    ])
      need(name);
  if (env.KUAIDI100_ENABLED === "true")
    for (const name of [
      "KUAIDI100_KEY",
      "KUAIDI100_CUSTOMER",
      "KUAIDI100_CALLBACK_SECRET",
    ])
      need(name);
  if (
    (env.ASSET_STORAGE ?? "local") === "s3" ||
    env.BACKUP_S3_ENABLED === "true"
  )
    for (const name of [
      "S3_REGION",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ])
      need(name);
  if (env.ASSET_STORAGE === "s3") need("S3_BUCKET");
  if (
    env.BACKUP_S3_ENABLED === "true" &&
    !env.BACKUP_S3_BUCKET &&
    !env.S3_BUCKET
  )
    problems.push("Remote backup requires BACKUP_S3_BUCKET or S3_BUCKET");
  for (const name of ["ALLOW_DEMO_RESET", "ALLOW_LEGACY_COMMANDS"])
    if (env[name] === "true")
      problems.push(`${name} must be false in production`);
  return problems;
}

export function hostSecretPath(env, containerPath) {
  if (!containerPath.startsWith("/run/secrets/"))
    throw new Error("Secret file must be under /run/secrets/");
  const root = resolve(env.SECRETS_PATH),
    path = resolve(root, containerPath.slice("/run/secrets/".length));
  const child = relative(root, path);
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw new Error("Secret path escapes SECRETS_PATH");
  return path;
}

export function validateRunningRelease(env, images, containers) {
  const problems = [];
  for (const service of ["api", "web"]) {
    const instances = containers[service];
    if (instances.length !== 1) {
      problems.push(`Expected exactly one ${service} container`);
      continue;
    }
    const current = instances[0];
    if (current.Image !== images[service].Id)
      problems.push(
        `${service} running image does not match the release image`,
      );
    if (
      current.Config.Labels?.["org.opencontainers.image.revision"] !==
      env.VCS_REF
    )
      problems.push(`${service} running revision does not match VCS_REF`);
    if (!current.State.Running || current.State.Health?.Status !== "healthy")
      problems.push(`${service} container must be running and healthy`);
    if (
      service === "api" &&
      !current.Config.Env.includes("SHOP_MODE=production")
    )
      problems.push("api running mode must be production");
  }
  return problems;
}

export function preflight(envFile, options = {}) {
  const file = resolve(envFile),
    env = parseEnv(readFileSync(file, "utf8"));
  const problems = validateProductionSettings(env);
  if (options.runtime && options.skipDocker)
    problems.push("Runtime verification requires Docker checks");
  if (!options.skipFiles && !problems.length) {
    const requirePrivate = (path, label) => {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
        throw new Error(
          `${label} must not be readable by group or other users`,
        );
    };
    requirePrivate(file, "Production environment file");
    for (const name of [
      "ENCRYPTION_KEY_FILE",
      "MONITOR_TOKEN_FILE",
      "ADMIN_PASSWORD_FILE",
      "WECHAT_PRIVATE_KEY_FILE",
      "WECHAT_PUBLIC_KEY_FILE",
      "WECHAT_API_V3_KEY_FILE",
      "ALIPAY_PRIVATE_KEY_FILE",
      "ALIPAY_PUBLIC_KEY_FILE",
    ])
      if (
        env[name] &&
        (!name.startsWith("WECHAT_") ||
          env.PAYMENT_CHANNELS.includes("wechat_")) &&
        (!name.startsWith("ALIPAY_") ||
          env.PAYMENT_CHANNELS.includes("alipay_"))
      )
        requirePrivate(hostSecretPath(env, env[name]), name);
    for (const name of ["PRODUCTION_STATE_PATH", "BACKUP_PATH", "ASSET_PATH"])
      accessSync(env[name], constants.R_OK | constants.W_OK);
  }
  if (!options.skipDocker && !problems.length) {
    const images = {};
    for (const service of ["api", "web"]) {
      const image = JSON.parse(
        execFileSync(
          "docker",
          ["image", "inspect", env[`${service.toUpperCase()}_IMAGE`]],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ),
      )[0];
      images[service] = image;
      const revision =
        image.Config.Labels?.["org.opencontainers.image.revision"];
      if (revision !== env.VCS_REF)
        problems.push(
          `${service.toUpperCase()}_IMAGE revision does not match VCS_REF`,
        );
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const compose = [
      "compose",
      "--env-file",
      file,
      "-p",
      env.COMPOSE_PROJECT_NAME,
      "-f",
      resolve(root, "deploy/compose.production.yaml"),
    ];
    const commandOptions = {
      env: { ...process.env, ...env, PRODUCTION_ENV_FILE: file },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    };
    execFileSync("docker", [...compose, "config", "--quiet"], commandOptions);
    if (options.runtime && !problems.length) {
      const containers = {};
      for (const service of ["api", "web"]) {
        const ids = execFileSync(
          "docker",
          [...compose, "ps", "-a", "-q", service],
          commandOptions,
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        containers[service] = ids.length
          ? JSON.parse(
              execFileSync("docker", ["inspect", ...ids], commandOptions),
            )
          : [];
      }
      problems.push(...validateRunningRelease(env, images, containers));
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    checks: {
      files: !options.skipFiles,
      imagesAndCompose: !options.skipDocker,
      runtime: Boolean(options.runtime),
    },
    externalServicesTested: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2),
      envFile = args.find((arg) => !arg.startsWith("--")) ?? ".env.production";
    const result = preflight(envFile, {
      skipDocker: args.includes("--skip-docker"),
      skipFiles: args.includes("--skip-files"),
      runtime: args.includes("--runtime"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error(
      "Production preflight failed while reading private files or checking Docker; no credentials were printed.",
    );
    process.exitCode = 1;
  }
}
