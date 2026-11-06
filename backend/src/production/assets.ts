import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { z } from "zod";
import { findSession, rateLimit } from "../auth";
import { demand } from "../permissions";
import { HttpError } from "../errors";
import { transaction, readDatabase, writeDatabase } from "../database";
import { releaseSnapshot } from "../storage";
import {
  imageBytes,
  IMAGE_MAX_BYTES,
  IMAGES_MAX_BYTES,
  IMAGE_MAX_COUNT,
} from "../../../shared/domain/images";

export type Asset = {
  id: string;
  storage: "local" | "s3";
  bucket: string | null;
  object_key: string;
  local_root: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  status: string;
  actor_id: string;
  request_id: string;
  source_sha256: string;
  location: string | null;
};

export function ensureAssetSchema(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS external_assets(
    id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,storage TEXT NOT NULL CHECK(storage IN ('local','s3')),
    bucket TEXT,object_key TEXT NOT NULL,local_root TEXT,mime TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes>0),sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('uploading','ready')),created_at INTEGER NOT NULL,
    UNIQUE(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS external_asset_copies(
      asset_id TEXT NOT NULL REFERENCES external_assets(id),target TEXT NOT NULL,
      verified_sha256 TEXT NOT NULL,copied_at INTEGER NOT NULL,PRIMARY KEY(asset_id,target));`);
  if (
    !sql
      .prepare("PRAGMA table_info(external_assets)")
      .all()
      .some((column) => column.name === "location")
  )
    sql.exec("ALTER TABLE external_assets ADD COLUMN location TEXT");
}

export function assetConfig(): {
  storage: "local" | "s3";
  localRoot: string;
  prefix: string;
} {
  const storage = process.env.ASSET_STORAGE ?? "local";
  if (storage !== "local" && storage !== "s3")
    throw new Error("ASSET_STORAGE must be local or s3");
  const localRoot = resolve(
    process.env.ASSET_DIR ??
      resolve(
        dirname(process.env.DATABASE_PATH ?? "data/shopmate.sqlite"),
        "assets",
      ),
  );
  return {
    storage,
    localRoot,
    prefix: (process.env.S3_PREFIX ?? "shopmate").replace(/^\/+|\/+$/g, ""),
  };
}

export function s3Config() {
  const endpoint = process.env.S3_ENDPOINT;
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (process.env.SHOP_MODE === "production" && url.protocol !== "https:")
    )
      throw new Error(
        "S3_ENDPOINT must be a trusted HTTPS endpoint in production",
      );
  }
  if (
    !process.env.S3_REGION ||
    !process.env.S3_ACCESS_KEY_ID ||
    !process.env.S3_SECRET_ACCESS_KEY
  )
    throw new HttpError(503, "S3 凭据尚未配置", "S3_NOT_CONFIGURED");
  return {
    region: process.env.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    maxAttempts: 1,
    requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 },
  };
}

function storageLocation() {
  return JSON.stringify({
    endpoint: process.env.S3_ENDPOINT ?? null,
    region: process.env.S3_REGION,
    pathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
}

function clientForAsset(row: Asset) {
  const current = s3Config();
  const location = z
    .object({
      endpoint: z.string().nullable(),
      region: z.string().min(1),
      pathStyle: z.boolean(),
    })
    .parse(row.location ? JSON.parse(row.location) : null);
  if (
    location.endpoint &&
    process.env.SHOP_MODE === "production" &&
    new URL(location.endpoint).protocol !== "https:"
  )
    throw new Error("Stored S3 asset endpoint must use HTTPS in production");
  const useSource =
    process.env.S3_SOURCE_ENDPOINT === (location.endpoint ?? "aws");
  if (
    useSource &&
    (!process.env.S3_SOURCE_ACCESS_KEY_ID ||
      !process.env.S3_SOURCE_SECRET_ACCESS_KEY)
  )
    throw new Error("S3_SOURCE credentials must be configured together");
  return new S3Client({
    ...current,
    endpoint: location.endpoint ?? undefined,
    region: location.region,
    forcePathStyle: location.pathStyle,
    ...(useSource
      ? {
          credentials: {
            accessKeyId: process.env.S3_SOURCE_ACCESS_KEY_ID!,
            secretAccessKey: process.env.S3_SOURCE_SECRET_ACCESS_KEY!,
          },
        }
      : {}),
  });
}

export function validateAssetConfig() {
  const cfg = assetConfig();
  if (cfg.storage === "s3") {
    s3Config();
    if (!process.env.S3_BUCKET)
      throw new Error("S3_BUCKET is required for s3 asset storage");
  }
}

export function assetReference(source: string) {
  return /^\/api\/assets\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
    source,
  )?.[1];
}

export function validateAssetReferences(
  sql: DatabaseSync,
  sources: string[],
  maximum = IMAGE_MAX_COUNT,
) {
  if (!sources.length || sources.length > maximum)
    throw new HttpError(400, `请提供 1 至 ${maximum} 张图片`, "INVALID_INPUT");
  let total = 0;
  for (const source of sources) {
    const id = assetReference(source);
    if (!id) {
      total += imageBytes(source);
      continue;
    }
    const row = sql
      .prepare(
        "SELECT bytes FROM external_assets WHERE id=? AND status='ready'",
      )
      .get(id);
    if (!row)
      throw new HttpError(400, "图片不存在或尚未上传完成", "ASSET_NOT_READY");
    if (Number(row.bytes) > IMAGE_MAX_BYTES)
      throw new HttpError(400, "单张图片不能超过 2 MiB", "INVALID_INPUT");
    total += Number(row.bytes);
  }
  if (total > IMAGES_MAX_BYTES)
    throw new HttpError(400, "商品图片合计不能超过 5 MiB", "INVALID_INPUT");
  return total;
}

export async function readAsset(row: Asset) {
  if (row.storage === "local") {
    if (!row.local_root) throw new Error("ASSET_LOCAL_ROOT_MISSING");
    const root = resolve(row.local_root),
      path = resolve(root, row.object_key);
    if (!path.startsWith(root + "/") && !path.startsWith(root + "\\"))
      throw new Error("ASSET_INVALID_PATH");
    return readFile(path);
  }
  const client = clientForAsset(row);
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: row.bucket!, Key: row.object_key }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
    if (!response.Body) throw new Error("ASSET_EMPTY_RESPONSE");
    const stream = response.Body as Readable;
    if (
      response.ContentLength !== undefined &&
      response.ContentLength > IMAGE_MAX_BYTES
    ) {
      stream.destroy();
      throw new Error("ASSET_OBJECT_TOO_LARGE");
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const part of stream as AsyncIterable<Uint8Array>) {
      length += part.length;
      if (length > IMAGE_MAX_BYTES) {
        stream.destroy();
        throw new Error("ASSET_OBJECT_TOO_LARGE");
      }
      chunks.push(Buffer.from(part));
    }
    return Buffer.concat(chunks);
  } finally {
    client.destroy();
  }
}

async function writeAsset(row: Asset, bytes: Buffer) {
  if (row.storage === "local") {
    const root = resolve(row.local_root!),
      path = resolve(root, row.object_key);
    if (!path.startsWith(root + "/") && !path.startsWith(root + "\\"))
      throw new Error("ASSET_INVALID_PATH");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
    return;
  }
  const client = clientForAsset(row);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: row.bucket!,
        Key: row.object_key,
        Body: bytes,
        ContentType: row.mime,
        Metadata: { sha256: row.sha256 },
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
  } finally {
    client.destroy();
  }
}

export async function uploadAsset(
  sql: DatabaseSync,
  actorId: string,
  input: { contentBase64: string; requestId: string },
) {
  ensureAssetSchema(sql);
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64) ||
    input.contentBase64.length % 4 !== 0
  )
    throw new HttpError(400, "图片编码无效", "INVALID_INPUT");
  const source = Buffer.from(input.contentBase64, "base64");
  if (
    source.toString("base64") !== input.contentBase64 ||
    source.length > IMAGE_MAX_BYTES
  )
    throw new HttpError(400, "请上传 2 MiB 内的图片", "INVALID_INPUT");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  let row = sql
    .prepare("SELECT * FROM external_assets WHERE actor_id=? AND request_id=?")
    .get(actorId, input.requestId) as Asset | undefined;
  if (row && row.source_sha256 !== sourceHash)
    throw new HttpError(409, "请求标识已用于其他图片", "IDEMPOTENCY_CONFLICT");
  if (row?.status === "ready")
    return { id: row.id, url: `/api/assets/${row.id}`, bytes: row.bytes };
  let bytes: Buffer;
  try {
    const image = sharp(source, {
      limitInputPixels: 20000000,
      animated: false,
    });
    const metadata = await image.metadata();
    if (
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error("INVALID_IMAGE_FORMAT");
    bytes = await image.rotate().webp({ quality: 90 }).toBuffer();
  } catch {
    throw new HttpError(
      400,
      "图片无法解码，请使用有效的 PNG/JPEG/WebP 图片",
      "INVALID_INPUT",
    );
  }
  if (bytes.length > IMAGE_MAX_BYTES)
    throw new HttpError(400, "处理后的图片超过 2 MiB", "INVALID_INPUT");
  if (!row) {
    const cfg = assetConfig();
    validateAssetConfig();
    const id = randomUUID(),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    row = {
      id,
      actor_id: actorId,
      request_id: input.requestId,
      source_sha256: sourceHash,
      location: cfg.storage === "s3" ? storageLocation() : null,
      storage: cfg.storage,
      bucket: cfg.storage === "s3" ? process.env.S3_BUCKET! : null,
      object_key:
        cfg.storage === "s3" ? `${cfg.prefix}/assets/${id}.webp` : `${id}.webp`,
      local_root: cfg.storage === "local" ? cfg.localRoot : null,
      mime: "image/webp",
      bytes: bytes.length,
      sha256,
      status: "uploading",
    };
    transaction(sql, () =>
      sql
        .prepare(
          "INSERT OR IGNORE INTO external_assets(id,actor_id,request_id,source_sha256,storage,bucket,object_key,local_root,mime,bytes,sha256,status,created_at,location) VALUES(?,?,?,?,?,?,?,?,?,?,?,'uploading',?,?)",
        )
        .run(
          row!.id,
          row!.actor_id,
          row!.request_id,
          row!.source_sha256,
          row!.storage,
          row!.bucket,
          row!.object_key,
          row!.local_root,
          row!.mime,
          row!.bytes,
          row!.sha256,
          Date.now(),
          row!.location,
        ),
    );
    row = sql
      .prepare(
        "SELECT * FROM external_assets WHERE actor_id=? AND request_id=?",
      )
      .get(actorId, input.requestId) as Asset;
    if (row.source_sha256 !== sourceHash)
      throw new HttpError(
        409,
        "请求标识已用于其他图片",
        "IDEMPOTENCY_CONFLICT",
      );
  }
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
    throw new HttpError(
      409,
      "图片处理版本已变化，请重新上传",
      "ASSET_PROCESSING_VERSION_CHANGED",
    );
  await writeAsset(row, bytes);
  sql
    .prepare("UPDATE external_assets SET status='ready' WHERE id=?")
    .run(row.id);
  return { id: row.id, url: `/api/assets/${row.id}`, bytes: row.bytes };
}

export async function copyAssets(
  sql: DatabaseSync,
  destination: "local" | "s3",
  options: { switch?: boolean; localRoot?: string } = {},
) {
  ensureAssetSchema(sql);
  const cfg = assetConfig();
  if (destination === "s3" && !process.env.S3_BUCKET)
    throw new Error("S3_BUCKET is required");
  const rows = sql
    .prepare("SELECT * FROM external_assets WHERE status='ready' ORDER BY id")
    .all() as Asset[];
  let copied = 0;
  for (const source of rows) {
    const bytes = await readAsset(source);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== source.sha256 || bytes.length !== source.bytes)
      throw new Error(`ASSET_SOURCE_CHECKSUM_MISMATCH:${source.id}`);
    const target: Asset = {
      ...source,
      storage: destination,
      bucket: destination === "s3" ? process.env.S3_BUCKET! : null,
      location: destination === "s3" ? storageLocation() : null,
      local_root:
        destination === "local"
          ? resolve(options.localRoot ?? cfg.localRoot)
          : null,
      object_key:
        destination === "s3"
          ? `${cfg.prefix}/assets/${source.id}.webp`
          : `${source.id}.webp`,
    };
    await writeAsset(target, bytes);
    const verified = await readAsset(target);
    if (createHash("sha256").update(verified).digest("hex") !== source.sha256)
      throw new Error("ASSET_COPY_CHECKSUM_MISMATCH");
    transaction(sql, () => {
      sql
        .prepare(
          "INSERT INTO external_asset_copies VALUES(?,?,?,?) ON CONFLICT(asset_id,target) DO UPDATE SET verified_sha256=excluded.verified_sha256,copied_at=excluded.copied_at",
        )
        .run(
          source.id,
          JSON.stringify([
            target.storage,
            target.bucket,
            target.object_key,
            target.local_root,
          ]),
          source.sha256,
          Date.now(),
        );
      if (options.switch)
        sql
          .prepare(
            "UPDATE external_assets SET storage=?,bucket=?,object_key=?,local_root=?,location=? WHERE id=? AND sha256=?",
          )
          .run(
            target.storage,
            target.bucket,
            target.object_key,
            target.local_root,
            target.location,
            source.id,
            source.sha256,
          );
    });
    copied++;
  }
  return { copied, switched: !!options.switch };
}

/** Explicit offline catalog conversion; historical order snapshots retain their original images. */
export async function importLegacyImages(
  sql: DatabaseSync,
  builtInDirectory: string,
  actorId: string,
) {
  const first = readDatabase(sql);
  let products: { id: string; images: string[] }[],
    categories: { id: string; image: string }[];
  try {
    products = first.products.map(({ id, images }) => ({
      id,
      images: [...images],
    }));
    categories = first.categories.map(({ id, image }) => ({ id, image }));
  } finally {
    releaseSnapshot(first);
  }
  const conversions = new Map<string, string>();
  for (const source of new Set([
    ...products.flatMap((product) => product.images),
    ...categories.map((category) => category.image),
  ])) {
    if (assetReference(source)) continue;
    imageBytes(source);
    const bytes = source.startsWith("data:")
      ? Buffer.from(source.slice(source.indexOf(",") + 1), "base64")
      : await readFile(
          resolve(builtInDirectory, source.slice("/images/".length)),
        );
    const requestId =
      "legacy-" + createHash("sha256").update(bytes).digest("hex");
    const uploaded = await uploadAsset(sql, actorId, {
      requestId,
      contentBase64: bytes.toString("base64"),
    });
    conversions.set(source, uploaded.url);
  }
  if (!conversions.size)
    return {
      convertedSources: 0,
      products: products.length,
      categories: categories.length,
    };
  transaction(sql, () => {
    const db = readDatabase(sql);
    try {
      for (const product of db.products) {
        const before = products.find((value) => value.id === product.id);
        if (
          !before ||
          JSON.stringify(before.images) !== JSON.stringify(product.images)
        )
          throw new Error("ASSET_CATALOG_CHANGED_DURING_IMPORT");
        if (product.images.some((image) => conversions.has(image))) {
          product.images = product.images.map(
            (image) => conversions.get(image) ?? image,
          );
          product.version = (product.version ?? 1) + 1;
        }
      }
      for (const category of db.categories) {
        const before = categories.find((value) => value.id === category.id);
        if (!before || before.image !== category.image)
          throw new Error("ASSET_CATALOG_CHANGED_DURING_IMPORT");
        if (conversions.has(category.image)) {
          category.image = conversions.get(category.image)!;
          category.version = (category.version ?? 1) + 1;
        }
      }
      db.revision++;
      writeDatabase(sql, db);
    } finally {
      releaseSnapshot(db);
    }
  });
  return {
    convertedSources: conversions.size,
    products: products.length,
    categories: categories.length,
  };
}

/** Copies referenced local images into the backup asset directory without mutating source files. */
export async function backupAssets(
  sql: DatabaseSync,
  destination: string,
  options: { snapshotSha256?: string } = {},
) {
  const rows = sql
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name='external_assets' AND type='table'",
    )
    .get()
    ? (sql
        .prepare(
          "SELECT * FROM external_assets WHERE storage='local' AND status='ready' ORDER BY id",
        )
        .all() as Asset[])
    : [];
  await mkdir(destination, { mode: 0o700 });
  const items = [];
  for (const row of rows) {
    const bytes = await readAsset(row);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      throw new Error("ASSET_BACKUP_CHECKSUM_MISMATCH");
    await writeFile(resolve(destination, `${row.id}.webp`), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    items.push({
      id: row.id,
      path: `${row.id}.webp`,
      sha256: row.sha256,
      bytes: row.bytes,
    });
  }
  await writeFile(
    resolve(destination, "manifest.json"),
    JSON.stringify(
      { format: 1, snapshotSha256: options.snapshotSha256, items },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  return {
    count: items.length,
    bytes: items.reduce((n, row) => n + row.bytes, 0),
  };
}

export function registerAssetRoutes(app: Express, sql: DatabaseSync) {
  app.post("/api/assets", async (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "catalog");
    rateLimit(sql, `assets:${actor!.id}`, 100, 60 * 60 * 1000);
    const input = z
      .object({
        contentBase64: z
          .string()
          .min(1)
          .max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4),
        requestId: z.string().min(1).max(128),
      })
      .strict()
      .parse(req.body);
    const result = await uploadAsset(sql, actor!.id, input);
    res.status(201).json(result);
  });
  app.get("/api/assets/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const row = sql
      .prepare("SELECT * FROM external_assets WHERE id=? AND status='ready'")
      .get(id) as Asset | undefined;
    if (!row) throw new HttpError(404, "图片不存在", "ASSET_NOT_FOUND");
    const etag = `"${row.sha256}"`;
    if (req.get("If-None-Match") === etag) return void res.status(304).end();
    const bytes = await readAsset(row);
    if (
      bytes.length !== row.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== row.sha256
    )
      throw new HttpError(502, "图片存储校验失败", "ASSET_CHECKSUM_MISMATCH");
    res
      .set({
        "Content-Type": row.mime,
        "Cache-Control": "public,max-age=86400,immutable",
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
      })
      .send(bytes);
  });
}
