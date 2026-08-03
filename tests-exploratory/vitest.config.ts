import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["tests-exploratory/global-setup.ts"],
    include: ["tests-exploratory/**/*.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
