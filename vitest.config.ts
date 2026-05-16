import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["src/testing/setup.ts"],
    env: {
      AURORA_CLUSTER_ARN: "arn:aws:rds:eu-central-1:123456789012:cluster:aurora-prod-titan-v2",
      AURORA_SECRET_ARN:  "arn:aws:secretsmanager:eu-central-1:123456789012:secret:aurora-prod-titan-v2-test",
      AURORA_DB_NAME:     "signals",
    },
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    },
  },
});
