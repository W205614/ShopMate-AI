import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import {
  backupDatabase,
  inspectBackup,
  restoreBackup,
} from "../src/maintenance";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function addAiFixture(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE support_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE support_tool_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
    CREATE TABLE support_proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE ai_index_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE knowledge_documents (id TEXT PRIMARY KEY, original BLOB NOT NULL, extracted TEXT NOT NULL);
    CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, vector BLOB NOT NULL);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(content);
    INSERT INTO support_runs VALUES ('run-1', 'queued');
    INSERT INTO support_tool_calls VALUES ('tool-1', 'run-1');
    INSERT INTO support_proposals VALUES ('proposal-1', 'confirmed');
    INSERT INTO ai_index_jobs VALUES ('index-1', 'pending');
    INSERT INTO knowledge_fts VALUES ('中文知识内容');
  `);
  sql
    .prepare("INSERT INTO knowledge_documents VALUES (?,?,?)")
    .run("doc-1", Buffer.alloc(3 * 1024 * 1024, 7), "退款不得超过实付金额");
  sql
    .prepare("INSERT INTO knowledge_chunks VALUES (?,?)")
    .run("chunk-1", Buffer.from(new Float32Array([0.25, 0.5]).buffer));
}

describe("AI backup coverage", () => {
  it("digests durable AI rows and restores document BLOBs, queued work and consumed proposals without whole-file reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-ai-backup-")),
      source = openDatabase(":memory:"),
      destination = join(directory, "ai.sqlite"),
      target = join(directory, "restored.sqlite"),
      oldConfirm = process.env.CONFIRM_RESTORE,
      actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    addAiFixture(source);
    vi.mocked(readFileSync).mockImplementation(((
      path: Parameters<typeof readFileSync>[0],
      ...args: unknown[]
    ) => {
      if (String(path).includes(".sqlite") && !String(path).endsWith(".json"))
        throw new Error("WHOLE_SQLITE_READ_FORBIDDEN");
      return Reflect.apply(actual.readFileSync, undefined, [path, ...args]);
    }) as typeof readFileSync);
    try {
      const manifest = await backupDatabase(source, destination);
      expect(manifest.format).toBe(1);
      expect(manifest.digests.ai).toMatch(/^[0-9a-f]{64}$/);
      for (const name of [
        "support_runs",
        "support_tool_calls",
        "support_proposals",
        "ai_index_jobs",
        "knowledge_documents",
        "knowledge_chunks",
      ])
        expect(manifest.counts[name]).toBe(1);
      expect(
        Object.keys(manifest.counts).some((name) =>
          name.startsWith("knowledge_fts"),
        ),
      ).toBe(false);
      expect(inspectBackup(destination)).toEqual(manifest);
      const second = await backupDatabase(
        source,
        join(directory, "second.sqlite"),
      );
      expect(second.digests.ai).toBe(manifest.digests.ai);
      process.env.CONFIRM_RESTORE = "STOPPED_AND_BACKED_UP";
      await restoreBackup(destination, target, { offline: true });
      const restored = new DatabaseSync(target, { readOnly: true });
      try {
        expect(
          restored
            .prepare("SELECT status FROM support_runs WHERE id='run-1'")
            .get()?.status,
        ).toBe("queued");
        expect(
          restored
            .prepare(
              "SELECT status FROM support_proposals WHERE id='proposal-1'",
            )
            .get()?.status,
        ).toBe("confirmed");
        expect(
          restored
            .prepare(
              "SELECT length(original) AS bytes, extracted FROM knowledge_documents",
            )
            .get(),
        ).toEqual({
          bytes: 3 * 1024 * 1024,
          extracted: "退款不得超过实付金额",
        });
        const blob = restored
          .prepare("SELECT original FROM knowledge_documents")
          .get()?.original;
        expect(
          Buffer.from(blob as Uint8Array).equals(
            Buffer.alloc(3 * 1024 * 1024, 7),
          ),
        ).toBe(true);
        expect(
          restored.prepare("SELECT count(*) AS n FROM knowledge_chunks").get()
            ?.n,
        ).toBe(1);
        expect(
          restored.prepare("SELECT count(*) AS n FROM support_tool_calls").get()
            ?.n,
        ).toBe(1);
      } finally {
        restored.close();
      }
    } finally {
      vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
      if (oldConfirm === undefined) delete process.env.CONFIRM_RESTORE;
      else process.env.CONFIRM_RESTORE = oldConfirm;
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects changed document bytes even when file checksum and row counts are updated", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-ai-corrupt-")),
      sql = openDatabase(":memory:"),
      path = join(directory, "ai.sqlite");
    try {
      addAiFixture(sql);
      const manifest = await backupDatabase(sql, path),
        writer = new DatabaseSync(path);
      writer
        .prepare("UPDATE knowledge_documents SET original=?")
        .run(Buffer.alloc(3 * 1024 * 1024, 8));
      writer.close();
      manifest.sha256 = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
      writeFileSync(path + ".manifest.json", JSON.stringify(manifest));
      expect(() => inspectBackup(path)).toThrow("备份摘要不匹配: digests");
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("still inspects format 1 manifests written before AI digests and counts existed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-ai-legacy-")),
      sql = openDatabase(":memory:"),
      path = join(directory, "legacy.sqlite");
    try {
      addAiFixture(sql);
      const manifest = await backupDatabase(sql, path);
      delete manifest.digests.ai;
      for (const key of Object.keys(manifest.counts))
        if (/^(?:ai_|support_|knowledge_)/.test(key))
          delete manifest.counts[key];
      writeFileSync(path + ".manifest.json", JSON.stringify(manifest));
      expect(inspectBackup(path)).toEqual(manifest);
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
