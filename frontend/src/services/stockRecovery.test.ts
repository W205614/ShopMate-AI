import { beforeEach, expect, it, vi } from "vitest";
import {
  clearStockRecovery,
  readStockRecovery,
  saveStockRecovery,
  type StockRecovery,
} from "./stockRecovery";
beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
const draft = (): StockRecovery => ({
  productId: "p1",
  skuId: "s1",
  name: "库存商品",
  beforeStock: 1,
  quantity: 2,
  cost: 100,
  reason: "补货",
  options: { requestId: "request-one", mode: "delta" },
  createdAt: Date.now(),
});
it("库存恢复信息按管理员隔离，旧请求清理不能删除新请求", () => {
  const value = draft();
  saveStockRecovery("admin-one", value);
  expect(readStockRecovery("admin-two")).toBeNull();
  expect(readStockRecovery("admin-one")).toEqual(value);
  saveStockRecovery("admin-one", {
    ...value,
    options: { ...value.options, requestId: "request-two" },
  });
  clearStockRecovery("admin-one", "request-one");
  expect(readStockRecovery("admin-one")?.options.requestId).toBe("request-two");
  clearStockRecovery("admin-one", "request-two");
  expect(readStockRecovery("admin-one")).toBeNull();
});
it("超过24小时及损坏恢复信息不允许继续提交", () => {
  saveStockRecovery("admin", { ...draft(), createdAt: Date.now() - 86400000 });
  expect(readStockRecovery("admin")).toBeNull();
  sessionStorage.setItem("shopmate:stock-recovery:admin", "{}");
  expect(readStockRecovery("admin")).toBeNull();
});
it("存储不可用时明确阻止提交准备", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => saveStockRecovery("admin", draft())).toThrow("尚未提交库存操作");
});
