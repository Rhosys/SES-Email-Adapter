import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["llm-tests/**/*.spec.ts", "llm-tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
