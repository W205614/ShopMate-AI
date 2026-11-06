import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import {
  inspectBackup,
  restoreBackup,
  backupDatabase,
  type BackupManifest,
} from "../maintenance";
import {
  s3Config,
  readAsset,
  copyAssets,
  importLegacyImages,
  backupAssets,
  type Asset,
} from "./assets";

const fileEntry = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    key: z.string().min(1).max(1024),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const bundleSchema = z
  .object({
    format: z.literal(1),
    snapshot: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sqlite$/),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string(),
    files: z.array(fileEntry).min(2).max(100002),
    assets: z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string().regex(/^[a-f0-9-]{36}\.webp$/),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive(),
        }),
      )
      .max(100000),
  })
  .strict();

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

function config() {
  const bucket = process.env.BACKUP_S3_BUCKET ?? process.env.S3_BUCKET;
  if (!bucket) throw new Error("BACKUP_S3_BUCKET or S3_BUCKET is required");
  const prefix = (process.env.BACKUP_S3_PREFIX ?? "backups").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!/^[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.split("/").includes(".."))
    throw new Error("BACKUP_S3_PREFIX is invalid");
  return { bucket, prefix };
}

async function get(client: S3Client, bucket: string, key: string) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(120000) },
  );
  if (!response.Body) throw new Error("BACKUP_REMOTE_EMPTY_RESPONSE");
  return response;
}

async function remoteHash(
  client: S3Client,
  bucket: string,
  key: string,
  expectedBytes: number,
) {
  const response = await get(client, bucket, key),
    hash = createHash("sha256");
  let length = 0;
  const stream = response.Body as Readable;
  for await (const bytes of stream) {
    length += bytes.length;
    if (length > expectedBytes) {
      stream.destroy();
      throw new Error("BACKUP_REMOTE_SIZE_MISMATCH");
    }
    hash.update(bytes);
  }
  if (length !== expectedBytes) throw new Error("BACKUP_REMOTE_SIZE_MISMATCH");
  return hash.digest("hex");
}

/** Accepts only an already verified standalone snapshot, never the live WAL database. */
export async function uploadRemoteBackup(path: string) {
  const source = resolve(path),
    manifest = inspectBackup(source);
  const { bucket, prefix } = config(),
    client = new S3Client(s3Config());
  const root = `${prefix}/${basename(source)}-${manifest.sha256.slice(0, 16)}`;
  const files: z.infer<typeof fileEntry>[] = [];
  try {
    for (const local of [source, source + ".manifest.json"]) {
      const name = basename(local),
        key = `${root}/${name}`,
        bytes = (await stat(local)).size,
        sha256 = await sha256File(local);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(local),
          ContentLength: bytes,
          Metadata: { sha256 },
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
      if ((await remoteHash(client, bucket, key, bytes)) !== sha256)
        throw new Error("BACKUP_REMOTE_CHECKSUM_MISMATCH");
      files.push({ name, key, bytes, sha256 });
    }
    const assets: z.infer<typeof bundleSchema>["assets"] = [];
    const snapshot = new DatabaseSync(source, { readOnly: true });
    try {
      if (
        snapshot
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='external_assets' AND type='table'",
          )
          .get()
      ) {
        const rows = snapshot
          .prepare(
            "SELECT * FROM external_assets WHERE status='ready' ORDER BY id",
          )
          .all() as Asset[];
        const localAssets = rows.some((row) => row.storage === "local")
          ? await readLocalAssetIndex(source, manifest.sha256)
          : undefined;
        for (const row of rows) {
          let bytes: Buffer;
          if (row.storage === "local") {
            const entry = localAssets!.get(row.id);
            if (
              !entry ||
              entry.sha256 !== row.sha256 ||
              entry.bytes !== row.bytes
            )
              throw new Error("BACKUP_ASSET_SIDECAR_MISMATCH");
            bytes = await readFile(resolve(source + ".assets", entry.path));
          } else bytes = await readAsset(row);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (sha256 !== row.sha256 || bytes.length !== row.bytes)
            throw new Error("BACKUP_ASSET_CHECKSUM_MISMATCH");
          const name = `${row.id}.webp`,
            key = `${root}/${name}`;
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bytes,
              ContentType: "image/webp",
              Metadata: { sha256 },
            }),
            { abortSignal: AbortSignal.timeout(30000) },
          );
          if ((await remoteHash(client, bucket, key, bytes.length)) !== sha256)
            throw new Error("BACKUP_ASSET_REMOTE_CHECKSUM_MISMATCH");
          files.push({ name, key, bytes: bytes.length, sha256 });
          assets.push({ id: row.id, name, sha256, bytes: bytes.length });
        }
      }
    } finally {
      snapshot.close();
    }
    const bundle = {
      format: 1 as const,
      snapshot: basename(source),
      snapshotSha256: manifest.sha256,
      createdAt: new Date().toISOString(),
      files,
      assets,
    };
    const serialized = JSON.stringify(bundle);
    // Publish the recovery marker last. Partial uploads have no usable marker.
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${root}/bundle.json`,
        Body: serialized,
        ContentType: "application/json",
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    return {
      bucket,
      bundleKey: `${root}/bundle.json`,
      sha256: manifest.sha256,
      files: files.length,
      assets: assets.length,
    };
  } finally {
    client.destroy();
  }
}

async function readLocalAssetIndex(snapshot: string, snapshotHash: string) {
  const directory = snapshot + ".assets";
  const manifest = z
    .object({
      format: z.literal(1),
      snapshotSha256: z.string(),
      items: z.array(
        z.object({
          id: z.uuid(),
          path: z.string().regex(/^[a-f0-9-]{36}\.webp$/),
          sha256: z.string(),
          bytes: z.number().int().positive(),
        }),
      ),
    })
    .parse(
      JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")),
    );
  const entries = new Map(manifest.items.map((entry) => [entry.id, entry]));
  if (
    manifest.snapshotSha256 !== snapshotHash ||
    entries.size !== manifest.items.length
  )
    throw new Error("BACKUP_ASSET_SIDECAR_MISMATCH");
  return entries;
}

export async function downloadRemoteBackup(
  bundleKey: string,
  destination: string,
) {
  const { bucket, prefix } = config();
  if (
    !bundleKey.startsWith(prefix + "/") ||
    !bundleKey.endsWith("/bundle.json") ||
    bundleKey.includes("..")
  )
    throw new Error("BACKUP_REMOTE_KEY_INVALID");
  const client = new S3Client(s3Config()),
    root = resolve(destination);
  // Recovery material must use a new directory; existing evidence is never overwritten.
  await mkdir(root, { mode: 0o700 });
  try {
    const response = await get(client, bucket, bundleKey);
    const stream = response.Body as Readable,
      parts: Buffer[] = [];
    let length = 0;
    for await (const bytes of stream) {
      length += bytes.length;
      if (length > 32 * 1024 * 1024) {
        stream.destroy();
        throw new Error("BACKUP_BUNDLE_TOO_LARGE");
      }
      parts.push(Buffer.from(bytes));
    }
    const bundle = bundleSchema.parse(
      JSON.parse(Buffer.concat(parts).toString("utf8")),
    );
    const allowedRoot = bundleKey.slice(0, -"bundle.json".length);
    const names = new Set<string>();
    for (const entry of bundle.files) {
      if (names.has(entry.name) || entry.key !== allowedRoot + entry.name)
        throw new Error("BACKUP_BUNDLE_KEY_INVALID");
      names.add(entry.name);
      const download = await get(client, bucket, entry.key),
        hash = createHash("sha256");
      let received = 0;
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > entry.bytes)
            return callback(new Error("BACKUP_DOWNLOAD_SIZE_MISMATCH"));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        download.Body as Readable,
        verifier,
        createWriteStream(resolve(root, entry.name), {
          flags: "wx",
          mode: 0o600,
        }),
      );
      if (received !== entry.bytes || hash.digest("hex") !== entry.sha256)
        throw new Error("BACKUP_DOWNLOAD_CHECKSUM_MISMATCH");
    }
    if (
      !names.has(bundle.snapshot) ||
      !names.has(bundle.snapshot + ".manifest.json")
    )
      throw new Error("BACKUP_BUNDLE_SNAPSHOT_MISSING");
    for (const asset of bundle.assets) {
      const entry = bundle.files.find((file) => file.name === asset.name);
      if (
        !entry ||
        entry.sha256 !== asset.sha256 ||
        entry.bytes !== asset.bytes
      )
        throw new Error("BACKUP_BUNDLE_ASSET_INVALID");
    }
    const manifest = inspectBackup(resolve(root, bundle.snapshot));
    if (manifest.sha256 !== bundle.snapshotSha256)
      throw new Error("BACKUP_BUNDLE_SNAPSHOT_MISMATCH");
    await writeFile(
      resolve(root, "bundle.json"),
      JSON.stringify(bundle, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    return {
      snapshot: resolve(root, bundle.snapshot),
      assets: bundle.assets.length,
      sha256: manifest.sha256,
    };
  } finally {
    client.destroy();
  }
}

export async function restoreRemoteBundle(
  directory: string,
  databasePath: string,
  assetDirectory: string,
) {
  const root = resolve(directory),
    bundle = bundleSchema.parse(
      JSON.parse(await readFile(resolve(root, "bundle.json"), "utf8")),
    );
  // Verify every object before invoking the existing offline restore command.
  for (const entry of bundle.files)
    if (
      (await stat(resolve(root, entry.name))).size !== entry.bytes ||
      (await sha256File(resolve(root, entry.name))) !== entry.sha256
    )
      throw new Error("BACKUP_BUNDLE_LOCAL_CHECKSUM_MISMATCH");
  return restoreSnapshotAssets(
    resolve(root, bundle.snapshot),
    root,
    bundle.assets,
    databasePath,
    assetDirectory,
    true,
  );
}

async function restoreSnapshotAssets(
  snapshot: string,
  sourceDirectory: string,
  entries: z.infer<typeof bundleSchema>["assets"],
  databasePath: string,
  assetDirectory: string,
  allAssets: boolean,
) {
  if (process.env.CONFIRM_RESTORE !== "STOPPED_AND_BACKED_UP")
    throw new Error(
      "恢复前必须停止服务并设置 CONFIRM_RESTORE=STOPPED_AND_BACKED_UP",
    );
  const source = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const expected = source
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='external_assets' AND type='table'",
      )
      .get()
      ? source
          .prepare(
            `SELECT id,bytes,sha256 FROM external_assets WHERE status='ready' ${allAssets ? "" : "AND storage='local'"} ORDER BY id`,
          )
          .all()
      : [];
    if (
      expected.length !== entries.length ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length ||
      expected.some(
        (row) =>
          !entries.some(
            (entry) =>
              entry.id === row.id &&
              entry.sha256 === row.sha256 &&
              entry.bytes === row.bytes,
          ),
      )
    )
      throw new Error("BACKUP_ASSET_MANIFEST_INCOMPLETE");
  } finally {
    source.close();
  }
  for (const entry of entries) {
    const path = resolve(sourceDirectory, entry.name);
    if (
      (await stat(path)).size !== entry.bytes ||
      (await sha256File(path)) !== entry.sha256
    )
      throw new Error("BACKUP_ASSET_LOCAL_CHECKSUM_MISMATCH");
  }
  const assets = resolve(assetDirectory);
  await mkdir(assets, { mode: 0o700 });
  for (const entry of entries)
    await writeFile(
      resolve(assets, entry.name),
      await readFile(resolve(sourceDirectory, entry.name)),
      { flag: "wx", mode: 0o600 },
    );
  const result = await restoreBackup(snapshot, resolve(databasePath), {
    offline: true,
  });
  const sql = new DatabaseSync(resolve(databasePath));
  try {
    if (entries.length) {
      sql.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of entries)
          sql
            .prepare(
              "UPDATE external_assets SET storage='local',bucket=NULL,object_key=?,local_root=?,location=NULL WHERE id=? AND sha256=?",
            )
            .run(entry.name, assets, entry.id, entry.sha256);
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    sql.close();
  }
  return {
    ...result,
    assetDirectory: assets,
    assetCount: entries.length,
  };
}

export async function restoreLocalBackup(
  snapshotPath: string,
  databasePath: string,
  assetDirectory: string,
) {
  const snapshot = resolve(snapshotPath),
    manifest = inspectBackup(snapshot),
    directory = snapshot + ".assets";
  const value = existsSync(resolve(directory, "manifest.json"))
    ? z
        .object({
          format: z.literal(1),
          snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
          items: z.array(
            z.object({
              id: z.uuid(),
              path: z.string().regex(/^[a-f0-9-]{36}\.webp$/),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              bytes: z.number().int().positive(),
            }),
          ),
        })
        .strict()
        .parse(
          JSON.parse(
            await readFile(resolve(directory, "manifest.json"), "utf8"),
          ),
        )
    : { format: 1 as const, snapshotSha256: manifest.sha256, items: [] };
  if (value.snapshotSha256 !== manifest.sha256)
    throw new Error("BACKUP_ASSET_SNAPSHOT_MISMATCH");
  return restoreSnapshotAssets(
    snapshot,
    directory,
    value.items.map(({ path, ...entry }) => ({ ...entry, name: path })),
    databasePath,
    assetDirectory,
    false,
  );
}

export async function createLocalBackup(
  databasePath: string,
  destination: string,
  reason: BackupManifest["reason"] = "manual",
) {
  let reader: DatabaseSync | undefined = new DatabaseSync(
    resolve(databasePath),
    { readOnly: true },
  );
  const close = () => {
    if (reader?.isTransaction) reader.exec("ROLLBACK");
    reader?.close();
    reader = undefined;
  };
  try {
    reader.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    reader.prepare("SELECT revision FROM storage_meta WHERE id=1").get();
    const manifest = await backupDatabase(reader, resolve(destination), {
      reason,
      afterCopy: close,
    });
    const snapshot = new DatabaseSync(resolve(destination), { readOnly: true });
    try {
      const assets = await backupAssets(
        snapshot,
        resolve(destination) + ".assets",
        { snapshotSha256: manifest.sha256 },
      );
      return {
        snapshot: resolve(destination),
        sha256: manifest.sha256,
        createdAt: manifest.createdAt,
        assets,
      };
    } finally {
      snapshot.close();
    }
  } finally {
    close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "upload" && args.length === 1)
    return uploadRemoteBackup(args[0]);
  if (command === "download" && args.length === 2)
    return downloadRemoteBackup(args[0], args[1]);
  if (command === "restore" && args.length === 3)
    return restoreRemoteBundle(args[0], args[1], args[2]);
  if (command === "restore-local" && args.length === 3)
    return restoreLocalBackup(args[0], args[1], args[2]);
  if (command === "backup-local" && args.length >= 2 && args.length <= 3)
    return createLocalBackup(
      args[0],
      args[1],
      z
        .enum(["manual", "daily", "preupgrade", "pre-restore"])
        .parse(args[2] ?? "manual"),
    );
  if (command === "assets-import-legacy" && args.length === 2) {
    const path = resolve(args[0]);
    if (existsSync(path + ".running"))
      throw new Error("ASSET_IMPORT_REQUIRES_OFFLINE_DATABASE");
    const sql = new DatabaseSync(path);
    try {
      const owner = sql
        .prepare(
          "SELECT a.id FROM accounts a JOIN staff_access s ON s.account_id=a.id WHERE a.role='admin' AND s.staff_role='owner' AND s.active=1 ORDER BY a.created_at,a.id LIMIT 1",
        )
        .get();
      if (!owner) throw new Error("ASSET_IMPORT_OWNER_REQUIRED");
      return await importLegacyImages(sql, resolve(args[1]), String(owner.id));
    } finally {
      sql.close();
    }
  }
  if (
    command === "assets-copy" &&
    args.length >= 2 &&
    ["local", "s3"].includes(args[1])
  ) {
    const sql = new DatabaseSync(resolve(args[0]));
    try {
      return await copyAssets(sql, args[1] as "local" | "s3", {
        switch: args.includes("--switch"),
      });
    } finally {
      sql.close();
    }
  }
  throw new Error(
    "Usage: remote-backup.ts backup-local <source.sqlite> <new-backup.sqlite> [manual|daily|preupgrade|pre-restore] | upload <verified.sqlite> | download <bundleKey> <new-directory> | restore <bundle-directory> <offline.sqlite> <new-assets-dir> | restore-local <verified.sqlite> <offline.sqlite> <new-assets-dir> | assets-copy <database> <local|s3> [--switch] | assets-import-legacy <offline.sqlite> <builtin-images-directory>",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "REMOTE_BACKUP_COMMAND_FAILED: check configuration, offline state and retained recovery material",
      );
      process.exitCode = 1;
    });
