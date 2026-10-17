import { expect, it } from "vitest";
import { money } from "./types";
it("formats integer cents exactly without rounding through floating point yuan", () => {
  expect(money(0)).toBe("¥0.00");
  expect(money(1)).toBe("¥0.01");
  expect(money(-101)).toBe("¥-1.01");
  expect(money(Number.MAX_SAFE_INTEGER)).toBe("¥90,071,992,547,409.91");
  expect(money(BigInt(Number.MAX_SAFE_INTEGER) * 3n)).toBe(
    "¥270,215,977,642,229.73",
  );
});
