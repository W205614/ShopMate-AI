import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  actor: "admin",
  ready: true,
  request: vi.fn(),
}));
vi.mock("./repository", () => ({
  getSession: () => (state.actor ? { id: state.actor } : null),
  requireFreshState: () => {
    if (!state.ready) throw Error("请重新连接");
  },
  request: state.request,
  RequestError: class extends Error {
    outcome: string;
    constructor(message: string, outcome: string) {
      super(message);
      this.outcome = outcome;
    }
  },
}));
import { documentCommand } from "./supportDocuments";
import { RequestError } from "./repository";

beforeEach(() => {
  sessionStorage.clear();
  state.actor = "admin";
  state.ready = true;
  state.request.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("未知响应重试复用同一请求标识，成功后清理恢复记录", async () => {
  state.request
    .mockRejectedValueOnce(new RequestError("网络中断", "unknown"))
    .mockResolvedValueOnce({ document: { id: "d1" } });
  const input = { action: "publish", version: 1 };
  await expect(
    documentCommand("/api/support/documents/d1/actions", input),
  ).rejects.toThrow("网络中断");
  expect(sessionStorage.length).toBe(1);
  await documentCommand("/api/support/documents/d1/actions", input);
  const bodies = state.request.mock.calls.map((call) => call[1]);
  expect(bodies[0].requestId).toBe(bodies[1].requestId);
  expect(bodies[0]).toEqual({ ...input, requestId: expect.any(String) });
  expect(sessionStorage.length).toBe(0);
});

it("明确拒绝不会留下待确认恢复记录，重新编辑后可再次提交", async () => {
  state.request.mockRejectedValueOnce(
    new RequestError("版本已变化", "rejected"),
  );
  await expect(
    documentCommand("/api/support/documents/d1/actions", {
      action: "save",
      version: 1,
      text: "原稿",
    }),
  ).rejects.toThrow("版本已变化");
  expect(sessionStorage.length).toBe(0);
});

it("摘要计算期间切换身份不会提交旧管理员的文档", async () => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => Promise<void>;
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
    (algorithm, data) =>
      new Promise<ArrayBuffer>((resolve) => {
        release = async () => resolve(await digest(algorithm, data));
      }),
  );
  const command = documentCommand("/api/support/documents", {
    name: "private.txt",
    contentBase64: "YQ==",
  });
  state.actor = "other-admin";
  await release();
  await expect(command).rejects.toThrow("登录身份已变化");
  expect(state.request).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});

it("状态未同步或未登录时不提交文档", async () => {
  state.ready = false;
  await expect(documentCommand("/api/support/documents", {})).rejects.toThrow(
    "重新连接",
  );
  state.ready = true;
  state.actor = "";
  await expect(documentCommand("/api/support/documents", {})).rejects.toThrow(
    "请登录",
  );
  expect(state.request).not.toHaveBeenCalled();
});
