import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("drizzle schema ↔ migration sync", () => {
  it("schema.ts has no unmigrated changes", async () => {
    // drizzle-kit generate exits 0 regardless — check stdout for "No schema changes"
    const { stdout } = await execFileAsync(
      "npx", ["drizzle-kit", "generate", "--name", "drift-test"],
      { cwd: process.cwd() },
    );
    expect(stdout).toContain("No schema changes");
  }, { timeout: 15_000 });

  it("existing migrations are internally consistent", async () => {
    const { stdout } = await execFileAsync(
      "npx", ["drizzle-kit", "check"],
      { cwd: process.cwd() },
    );
    expect(stdout).toContain("fine");
  }, { timeout: 15_000 });
});
