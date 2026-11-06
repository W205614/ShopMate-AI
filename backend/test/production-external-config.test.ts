import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateExternalConfig } from "../src/production/external";

beforeEach(() => {
  vi.stubEnv("SHOP_MODE", "demo");
  vi.stubEnv("SMTP_HOST", "");
  vi.stubEnv("SMS_ENABLED", "false");
  vi.stubEnv("KUAIDI100_ENABLED", "false");
  vi.stubEnv("ASSET_STORAGE", "local");
  vi.stubEnv("BACKUP_S3_ENABLED", "true");
  vi.stubEnv("BACKUP_S3_BUCKET", "");
  vi.stubEnv("S3_BUCKET", "");
  vi.stubEnv("S3_REGION", "");
  vi.stubEnv("S3_ACCESS_KEY_ID", "");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "");
  vi.stubEnv("S3_ENDPOINT", "");
});
afterEach(() => vi.unstubAllEnvs());

it("requires remote backup credentials and a shared or dedicated bucket before startup", () => {
  vi.stubEnv("S3_BUCKET", "shared-backups");
  expect(() => validateExternalConfig()).toThrow("S3 凭据尚未配置");
  vi.stubEnv("S3_REGION", "us-east-1");
  vi.stubEnv("S3_ACCESS_KEY_ID", "synthetic-id");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "synthetic-secret");
  expect(() => validateExternalConfig()).not.toThrow();
  vi.stubEnv("S3_BUCKET", "");
  expect(() => validateExternalConfig()).toThrow(
    "BACKUP_S3_BUCKET or S3_BUCKET is required",
  );
  vi.stubEnv("BACKUP_S3_BUCKET", "dedicated-backups");
  expect(() => validateExternalConfig()).not.toThrow();
});

it("does not require unused remote backup credentials for a disabled leftover bucket", () => {
  vi.stubEnv("BACKUP_S3_ENABLED", "false");
  vi.stubEnv("BACKUP_S3_BUCKET", "leftover-backup-config");
  expect(() => validateExternalConfig()).not.toThrow();
  vi.stubEnv("ASSET_STORAGE", "s3");
  expect(() => validateExternalConfig()).toThrow("S3 凭据尚未配置");
});

it("requires both verification and business templates whenever SMS is enabled", () => {
  vi.stubEnv("BACKUP_S3_ENABLED", "false");
  vi.stubEnv("SMS_ENABLED", "true");
  vi.stubEnv("ALIYUN_ACCESS_KEY_ID", "synthetic-id");
  vi.stubEnv("ALIYUN_ACCESS_KEY_SECRET", "synthetic-secret");
  vi.stubEnv("ALIYUN_SMS_SIGN_NAME", "合成商城");
  vi.stubEnv("ALIYUN_SMS_TEMPLATE_VERIFICATION", "SMS_VERIFY_TEST");
  vi.stubEnv("ALIYUN_SMS_TEMPLATE_TRANSACTION", "");
  expect(() => validateExternalConfig()).toThrow("短信渠道尚未配置");
  vi.stubEnv("ALIYUN_SMS_TEMPLATE_TRANSACTION", "SMS_TRANSACTION_TEST");
  expect(() => validateExternalConfig()).not.toThrow();
  vi.stubEnv("ALIYUN_SMS_TEMPLATE_VERIFICATION", "");
  expect(() => validateExternalConfig()).toThrow("短信渠道尚未配置");
});
