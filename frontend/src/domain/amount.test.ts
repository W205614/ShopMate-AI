import { expect, it } from "vitest";
import { yuanToCents, centsToYuan } from "./amount";
it("converts yuan input exactly to safe integer cents without rounding", () => {
  expect(yuanToCents("0.01")).toBe(1);
  expect(yuanToCents("99.90")).toBe(9990);
  expect(yuanToCents("123.45")).toBe(12345);
  expect(centsToYuan(9990)).toBe("99.90");
  expect(yuanToCents("0.00", 0)).toBe(0);
  for (const value of [
    "",
    "-1",
    "1.001",
    "1e2",
    "NaN",
    "900719925474099.99",
    "0.00",
  ])
    expect(() => yuanToCents(value)).toThrow();
});
