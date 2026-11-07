import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    pool: "threads",
    maxWorkers: 2,
    include: ["src/**/*.test.ts"],
    clearMocks: true,
  },
});
