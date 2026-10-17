import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Authentication intentionally uses expensive scrypt; shared CI runners may be slower.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
