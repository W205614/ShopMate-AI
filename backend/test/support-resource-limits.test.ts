import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDatabase,
  queryRecord,
  readDatabase,
  writeDatabase,
} from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { ensureRuntimeSchema } from "../src/runtime";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import type { Conversation } from "../../shared/domain/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function command<T>(
  sql: ReturnType<typeof openDatabase>,
  method: string,
  args: unknown[],
  work: () => T,
  requestId = crypto.randomUUID(),
) {
  return context.run(
    {
      sql,
      user: { id: "u1", name: "合成用户", role: "user" },
      admin: null,
      command: { method, args, requestId, fingerprint: JSON.stringify(args) },
    },
    work,
  );
}

function fixture() {
  vi.stubEnv("AI_ENABLED", "false");
  const sql = openDatabase(":memory:");
  const seed = createSeed();
  seed.conversations = [];
  writeDatabase(sql, seed);
  ensureRuntimeSchema(sql);
  return sql;
}

describe("bounded conversation mutations", () => {
  it("counts new conversations transactionally and permits a lost-response replay at the cap", async () => {
    vi.stubEnv("SUPPORT_DAILY_CONVERSATIONS", "1");
    const sql = fixture();
    try {
      const requestId = crypto.randomUUID();
      const first = await command(
        sql,
        "createConversation",
        [],
        () => supportApi.createConversation(),
        requestId,
      );
      const replay = await command(
        sql,
        "createConversation",
        [],
        () => supportApi.createConversation(),
        requestId,
      );
      expect(replay).toBe(first);
      await expect(
        command(sql, "createConversation", [], () =>
          supportApi.createConversation(),
        ),
      ).rejects.toMatchObject({ code: "SUPPORT_CONVERSATION_LIMIT" });
      expect(readDatabase(sql).conversations).toHaveLength(1);
      expect(
        sql
          .prepare("SELECT used FROM ai_daily_usage WHERE kind='conversation'")
          .get()?.used,
      ).toBe(1);
    } finally {
      sql.close();
    }
  });

  it("mutates only the requested conversation, enforces turns without appending and still permits human handoff", async () => {
    vi.stubEnv("SUPPORT_MAX_USER_TURNS", "1");
    const sql = fixture();
    try {
      const own = await command(sql, "createConversation", [], () =>
        supportApi.createConversation(),
      );
      const seed = readDatabase(sql);
      seed.conversations.push({
        ...structuredClone(seed.conversations[0]!),
        id: "excluded",
        userId: "u2",
        title: "EXCLUDED_RECORD",
      });
      writeDatabase(sql, seed);
      const parse = JSON.parse;
      const spy = vi
        .spyOn(JSON, "parse")
        .mockImplementation((value, reviver) => {
          if (value.includes("EXCLUDED_RECORD"))
            throw new Error("parsed unrelated conversation");
          return parse(value, reviver);
        });
      await command(sql, "sendMessage", [own, "你好"], () =>
        supportApi.sendMessage(own, "你好"),
      );
      const before = queryRecord<Conversation>(sql, "conversations", own)!;
      await expect(
        command(sql, "sendMessage", [own, "再次咨询"], () =>
          supportApi.sendMessage(own, "再次咨询"),
        ),
      ).rejects.toMatchObject({ code: "SUPPORT_TURN_LIMIT" });
      expect(
        queryRecord<Conversation>(sql, "conversations", own)!.messages,
      ).toEqual(before.messages);
      await command(sql, "transferConversation", [own], () =>
        supportApi.transferConversation(own),
      );
      expect(queryRecord<Conversation>(sql, "conversations", own)!.status).toBe(
        "waiting",
      );
      spy.mockRestore();
      expect(
        queryRecord<Conversation>(sql, "conversations", "excluded")!.title,
      ).toBe("EXCLUDED_RECORD");
    } finally {
      sql.close();
    }
  });
});
