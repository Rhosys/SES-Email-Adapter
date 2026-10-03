import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests-production/**/*.spec.ts", "tests-production/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
