import { expect, it, vi } from "vitest";
import { openDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import { processSupportRun } from "../src/ai-support";
import { ensureSupportSchema } from "../src/ai-schema";
import { ensureKnowledgeSchema } from "../src/ai-knowledge";

it("never logs a model-supplied unknown tool name containing private text", async () => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("LLM_API_KEY", "synthetic-no-network");
  const sql = openDatabase(":memory:");
  const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
  try {
    writeDatabase(sql, createSeed());
    ensureSupportSchema(sql); ensureKnowledgeSchema(sql);
    const asUser = <T>(work: () => T) => context.run({ sql, user: { id: "u1", name: "合成用户", role: "user" }, admin: null }, work);
    const chat = await asUser(() => supportApi.createConversation());
    await asUser(() => supportApi.sendMessage(chat, "请帮我找商品"));
    const run = sql.prepare("SELECT id FROM support_runs WHERE conversation_id=?").get(chat)!;
    const unsafeName = "private-phone-13800000000-sk-SyntheticSecret123";
    const caller = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [
      { id: "bad-tool", type: "function", function: { name: unsafeName, arguments: "{}" } },
    ] }).mockResolvedValueOnce({ role: "assistant", content: JSON.stringify({ answer: "无法执行该操作，请转人工。", citations: [], productIds: [] }) });
    await processSupportRun(sql, String(run.id), caller);
    const events = logger.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events.find((event) => event.event === "support_tool_call")).toMatchObject({ runId: run.id, name: "unsupported_tool", ok: false });
    expect(JSON.stringify(events)).not.toContain(unsafeName);
    expect(JSON.stringify(events)).not.toContain("13800000000");
    expect(sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)?.status).toBe("completed");
  } finally { sql.close(); logger.mockRestore(); vi.unstubAllEnvs(); }
});
