import { afterEach, expect, it, vi } from "vitest";
import { integerSetting } from "../src/config";
import { aiConfig } from "../src/ai-provider";
import { knowledgeLimits } from "../src/ai-knowledge";

afterEach(() => vi.unstubAllEnvs());

it("uses defaults only when an integer setting is absent and accepts both bounds", () => {
  vi.stubEnv("AI_MAX_CONCURRENT", undefined);
  expect(aiConfig().maxConcurrent).toBe(2);
  for (const value of ["1", "8"]) {
    vi.stubEnv("AI_MAX_CONCURRENT", value);
    expect(aiConfig().maxConcurrent).toBe(Number(value));
  }
});

it.each(["", "NaN", "1.5", "0", "9"])(
  "rejects explicit invalid integer %j",
  (value) => {
    vi.stubEnv("AI_MAX_CONCURRENT", value);
    expect(() => integerSetting("AI_MAX_CONCURRENT", 2, 1, 8)).toThrow(
      "AI_MAX_CONCURRENT",
    );
  },
);

it("validates provider timeouts and knowledge limits instead of silently defaulting", () => {
  vi.stubEnv("AI_PROVIDER_TIMEOUT_MS", "broken");
  expect(() => aiConfig()).toThrow("AI_PROVIDER_TIMEOUT_MS");
  vi.stubEnv("AI_KNOWLEDGE_MAX_CHUNKS", "-1");
  expect(() => knowledgeLimits()).toThrow("AI_KNOWLEDGE_MAX_CHUNKS");
});
