import type { Logger } from "../../src/logger.js";

let invocationId = "integration-test";

/**
 * Human-readable console logger for developer-run suites (integration, llm-tests,
 * tests-production). Unlike the production RequestLogger it does NOT redact, truncate,
 * or JSON-serialize — tests need to see the raw values they assert on, printed plainly
 * at the terminal.
 */
export function createConsoleLogger(): Logger {
  return {
    startInvocation(id: string) { invocationId = id; },
    getInvocationId() { return invocationId; },
    trackPoint() { /* no-op */ },
    info(msg, ctx) { console.log("[info]", msg, ctx ?? ""); },
    track(msg, ctx) { console.log("[track]", msg, ctx ?? ""); },
    warn(msg, ctx) { console.warn("[warn]", msg, ctx ?? ""); },
    error(msg, ctx) { console.error("[error]", msg, ctx ?? ""); },
    critical(msg, ctx) { console.error("[critical]", msg, ctx ?? ""); },
  };
}
