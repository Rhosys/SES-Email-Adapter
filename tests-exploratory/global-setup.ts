/**
 * Vitest globalSetup — prompts for IMAP credentials before tests run.
 * Runs in the main process where stdin is available.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function setup() {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    process.env.IMAP_HOST = await rl.question("IMAP host (e.g. imap.fastmail.com): ");
    process.env.IMAP_USERNAME = await rl.question("IMAP username: ");
    process.env.IMAP_PASSWORD = await rl.question("IMAP password: ");

    const tls = await rl.question("TLS mode [TLS/DISABLED] (default: TLS): ");
    process.env.IMAP_TLS = tls === "DISABLED" ? "DISABLED" : "TLS";
  } finally {
    rl.close();
  }
}
