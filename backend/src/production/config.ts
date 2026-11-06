import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PaymentChannel } from "../../../shared/domain/production";

export function shopMode(): "demo" | "production" {
  const mode = process.env.SHOP_MODE ?? "demo";
  if (mode !== "demo" && mode !== "production")
    throw new Error("SHOP_MODE must be demo or production");
  return mode;
}

export function secret(name: string) {
  const path = process.env[`${name}_FILE`];
  return path ? readFileSync(path, "utf8").trim() : process.env[name]?.trim();
}

export function productionConfig() {
  const mode = shopMode();
  const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:18086";
  const url = new URL(publicUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("PUBLIC_URL must be an origin without credentials or path");
  if (mode === "production" && url.protocol !== "https:")
    throw new Error("Production PUBLIC_URL requires HTTPS");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("PUBLIC_URL must use HTTP or HTTPS");
  const channels = (process.env.PAYMENT_CHANNELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = ["wechat_native", "wechat_h5", "alipay_page", "alipay_wap"];
  if (
    channels.some((value) => !allowed.includes(value)) ||
    new Set(channels).size !== channels.length
  )
    throw new Error(
      "PAYMENT_CHANNELS contains an unsupported or duplicate channel",
    );
  const encoded = secret("ENCRYPTION_KEY");
  const encryptionKey = encoded ? Buffer.from(encoded, "base64") : undefined;
  if (
    encryptionKey &&
    (encryptionKey.length !== 32 ||
      encryptionKey.toString("base64") !== encoded)
  )
    throw new Error("ENCRYPTION_KEY must be 32 random bytes encoded as base64");
  const monitoringToken = secret("MONITOR_TOKEN");
  const emailEnabled = Boolean(process.env.SMTP_HOST);
  const smsEnabled = process.env.SMS_ENABLED === "true";
  if (mode === "production") {
    if (!encryptionKey)
      throw new Error("Production requires ENCRYPTION_KEY_FILE");
    if (!monitoringToken || monitoringToken.length < 32)
      throw new Error(
        "Production requires a MONITOR_TOKEN of at least 32 characters",
      );
    if (!channels.length)
      throw new Error("Production requires at least one payment channel");
    if (!emailEnabled && !smsEnabled)
      throw new Error("Production requires email or SMS verification");
    if (process.env.COOKIE_SECURE !== "true")
      throw new Error("Production requires COOKIE_SECURE=true");
    if (
      process.env.ALLOW_DEMO_RESET === "true" ||
      process.env.ALLOW_LEGACY_COMMANDS === "true"
    )
      throw new Error("Production cannot enable demo reset or legacy commands");
  }
  return {
    mode,
    publicUrl: url.origin,
    encryptionKey,
    monitoringToken,
    paymentChannels: channels as PaymentChannel[],
    emailEnabled,
    smsEnabled,
  };
}

export function seal(
  value: string,
  key: Buffer | undefined = productionConfig().encryptionKey,
) {
  if (!key || key.length !== 32) throw new Error("ENCRYPTION_KEY_REQUIRED");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function unseal(
  value: string,
  key: Buffer | undefined = productionConfig().encryptionKey,
) {
  if (!key || key.length !== 32) throw new Error("ENCRYPTION_KEY_REQUIRED");
  const [version, nonce, tag, content] = value.split(".");
  if (version !== "v1" || !nonce || !tag || content === undefined)
    throw new Error("ENCRYPTED_VALUE_INVALID");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(content, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
