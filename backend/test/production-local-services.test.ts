import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { openDatabase } from "../src/database";
import { ensureRuntimeSchema } from "../src/runtime";
import { ensureExternalSchema } from "../src/production/external";
import {
  uploadAsset,
  readAsset,
  s3Config,
  type Asset,
} from "../src/production/assets";
import { sendVerification } from "../src/production/notifications";
import {
  uploadRemoteBackup,
  downloadRemoteBackup,
  restoreRemoteBundle,
  createLocalBackup,
} from "../src/production/remote-backup";

afterEach(() => vi.unstubAllEnvs());
function isolated(sql: DatabaseSync) {
  ensureRuntimeSchema(sql);
  ensureExternalSchema(sql);
  sql
    .prepare(
      "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES('service-admin','serviceadmin','合成管理员','admin','unused',1)",
    )
    .run();
}

it.runIf(Boolean(process.env.MAILPIT_SMTP_PORT && process.env.MAILPIT_API_URL))(
  "delivers the real SMTP adapter into Mailpit",
  async () => {
    vi.stubEnv("SHOP_MODE", "demo");
    vi.stubEnv("CONFIRM_RESTORE", "STOPPED_AND_BACKED_UP");
    vi.stubEnv("SMTP_HOST", "127.0.0.1");
    vi.stubEnv("SMTP_PORT", process.env.MAILPIT_SMTP_PORT!);
    vi.stubEnv("SMTP_SECURE", "false");
    vi.stubEnv("SMTP_USERNAME", "");
    vi.stubEnv("SMTP_PASSWORD", "");
    vi.stubEnv("SMTP_FROM", "ShopMate <shopmate@example.test>");
    const sql = openDatabase(":memory:");
    isolated(sql);
    const target = `${randomUUID()}@example.test`;
    try {
      await sendVerification(
        { channel: "email", target, code: "738291", challengeId: randomUUID() },
        sql,
      );
      const result = await (
        await fetch(process.env.MAILPIT_API_URL! + "/api/v1/messages")
      ).json();
      const message = result.messages.find(
        (item: { To: { Address: string }[] }) =>
          item.To.some((contact) => contact.Address === target),
      );
      expect(message).toBeTruthy();
      const content = await (
        await fetch(
          process.env.MAILPIT_API_URL! + "/api/v1/message/" + message.ID,
        )
      ).json();
      expect(content.Text).toContain("738291");
      expect(
        sql
          .prepare(
            "SELECT attempts FROM external_delivery_budget WHERE channel='email'",
          )
          .get()?.attempts,
      ).toBe(1);
    } finally {
      sql.close();
    }
  },
);

it.runIf(Boolean(process.env.S3MOCK_ENDPOINT))(
  "uploads images and a verified backup bundle to Adobe S3Mock and restores both",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "shopmate-s3mock-"));
    vi.stubEnv("SHOP_MODE", "demo");
    vi.stubEnv("CONFIRM_RESTORE", "STOPPED_AND_BACKED_UP");
    vi.stubEnv("ASSET_STORAGE", "s3");
    vi.stubEnv("S3_ENDPOINT", process.env.S3MOCK_ENDPOINT!);
    vi.stubEnv("S3_REGION", "us-east-1");
    vi.stubEnv("S3_BUCKET", "shopmate-external-" + randomUUID());
    vi.stubEnv("BACKUP_S3_BUCKET", process.env.S3_BUCKET!);
    vi.stubEnv("S3_ACCESS_KEY_ID", "synthetic-access");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "synthetic-secret");
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("S3_PREFIX", "acceptance-" + randomUUID());
    vi.stubEnv("BACKUP_S3_PREFIX", "backups-" + randomUUID());
    const sql = openDatabase(resolve(root, "source.sqlite"));
    isolated(sql);
    try {
      const provision = new S3Client(s3Config());
      try {
        await provision.send(
          new CreateBucketCommand({ Bucket: process.env.S3_BUCKET! }),
        );
      } finally {
        provision.destroy();
      }
      const content = await sharp({
        create: { width: 16, height: 16, channels: 3, background: "#103c2a" },
      })
        .png()
        .toBuffer();
      const item = await uploadAsset(sql, "service-admin", {
        requestId: randomUUID(),
        contentBase64: content.toString("base64"),
      });
      const row = sql
        .prepare("SELECT * FROM external_assets WHERE id=?")
        .get(item.id) as Asset;
      expect((await readAsset(row)).length).toBe(item.bytes);
      vi.stubEnv("ASSET_STORAGE", "local");
      vi.stubEnv("ASSET_DIR", resolve(root, "local-images"));
      const localItem = await uploadAsset(sql, "service-admin", {
        requestId: randomUUID(),
        contentBase64: content.toString("base64"),
      });
      const localRow = sql
        .prepare("SELECT * FROM external_assets WHERE id=?")
        .get(localItem.id) as Asset;
      const localBytes = await readAsset(localRow);
      const snapshot = resolve(root, "verified.sqlite");
      await createLocalBackup(resolve(root, "source.sqlite"), snapshot);
      await writeFile(
        resolve(localRow.local_root!, localRow.object_key),
        Buffer.from("corrupted original fixture"),
      );
      const remote = await uploadRemoteBackup(snapshot);
      expect(remote.assets).toBe(2);
      const downloaded = await downloadRemoteBackup(
        remote.bundleKey,
        resolve(root, "downloaded"),
      );
      expect(downloaded.sha256).toBe(remote.sha256);
      const restoredPath = resolve(root, "restored.sqlite"),
        assetDir = resolve(root, "restored-assets");
      await restoreRemoteBundle(
        resolve(root, "downloaded"),
        restoredPath,
        assetDir,
      );
      const restored = new DatabaseSync(restoredPath, { readOnly: true });
      try {
        const asset = restored
          .prepare("SELECT * FROM external_assets WHERE id=?")
          .get(item.id) as Asset;
        expect(asset.storage).toBe("local");
        expect(asset.local_root).toBe(assetDir);
        expect(await readAsset(asset)).toEqual(await readAsset(row));
        const restoredLocal = restored
          .prepare("SELECT * FROM external_assets WHERE id=?")
          .get(localItem.id) as Asset;
        expect(await readAsset(restoredLocal)).toEqual(localBytes);
        expect(
          restored
            .prepare("SELECT username FROM accounts WHERE id='service-admin'")
            .get()?.username,
        ).toBe("serviceadmin");
      } finally {
        restored.close();
      }
    } finally {
      sql.close();
    }
  },
  60000,
);
