import { afterEach, describe, expect, it, vi } from "vitest";
import { aiConfig, chat, embed, rerank, vision } from "../src/ai-provider";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function configure() {
  vi.stubEnv("LLM_API_KEY", "synthetic-provider-key");
  vi.stubEnv("LLM_BASE_URL", "https://provider.invalid/v1");
  vi.stubEnv("EMBEDDING_API_KEY", "synthetic-provider-key");
  vi.stubEnv("EMBEDDING_BASE_URL", "https://embedding.invalid/v1");
  vi.stubEnv("EMBEDDING_DIMENSION", "3");
  vi.stubEnv("EMBEDDING_DIMENSIONS", "");
  vi.stubEnv("RERANKER_API_KEY", "synthetic-provider-key");
  vi.stubEnv("RERANKER_URL", "https://reranker.invalid/v1/rerank");
}
describe("AI provider protocol and failure boundaries", () => {
  it("uses flash non-thinking requests, returns only safe token usage, never forwards raw usage fields", async () => {
    configure();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "好", tool_calls: [] } },
            ],
            usage: {
              prompt_tokens: 42,
              total_tokens: 44,
              internal_secret: "ignored",
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const response = await chat([{ role: "user", content: "你好" }]);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://provider.invalid/v1/chat/completions");
    expect(JSON.parse(request.body)).toMatchObject({
      model: aiConfig().model,
      thinking: { type: "disabled" },
      stream: false,
    });
    expect(response.usage).toEqual({ prompt_tokens: 42, total_tokens: 44 });
  });
  it("validates embedding dimensions, restores index ordering and supports providers omitting dimensions parameter", async () => {
    configure();
    vi.stubEnv("SEND_EMBEDDING_DIMENSIONS", "false");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1, 0] },
              { index: 0, embedding: [1, 0, 0] },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    expect(await embed(["甲", "乙"])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).not.toHaveProperty(
      "dimensions",
    );
    await expect(embed(["错维度"])).rejects.toMatchObject({
      code: "EMBEDDING_DIMENSION_MISMATCH",
    });
  });
  it("uses a full reranker URL once and rejects duplicate or out-of-bounds provider indices", async () => {
    configure();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.8 },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(rerank("售后", ["条款"])).rejects.toMatchObject({
      code: "RERANKER_INVALID_RESPONSE",
    });
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://reranker.invalid/v1/rerank",
    );
  });
  it("does not expose provider error response bodies or credentials", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("secret-provider-body", { status: 429 }),
        ),
    );
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject(
      { code: "PROVIDER_HTTP_429", message: "PROVIDER_HTTP_429", status: 429 },
    );
  });
  it("fails closed on malformed tool calls and truncated answers", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "a",
                        type: "function",
                        function: { name: "query", arguments: { x: 1 } },
                      },
                    ],
                  },
                },
              ],
            }),
          ),
        ),
    );
    await expect(chat([])).rejects.toMatchObject({
      code: "PROVIDER_INVALID_TOOLS",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "partial" },
                  finish_reason: "length",
                },
              ],
            }),
          ),
        ),
    );
    await expect(chat([])).rejects.toMatchObject({
      code: "PROVIDER_INVALID_CHAT",
    });
  });
  it("rejects unreadable image-only output while retaining uncertainty markers in a useful draft", async () => {
    configure();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "[无法辨认]" } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "金额199.00元；日期[无法辨认]；不支持退货。",
                },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      vision(Buffer.from("synthetic-image"), "image/png"),
    ).rejects.toMatchObject({ code: "DOCUMENT_UNREADABLE_IMAGE" });
    expect(await vision(Buffer.from("synthetic-image"), "image/png")).toContain(
      "日期[无法辨认]",
    );
  });
});
