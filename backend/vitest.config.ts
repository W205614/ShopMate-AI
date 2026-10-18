import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    include: ["test/**/*.test.ts"],
    // Authentication intentionally uses expensive scrypt; shared CI runners may be slower.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
