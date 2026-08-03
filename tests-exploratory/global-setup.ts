/**
 * Vitest globalSetup — prompts for IMAP credentials before tests run.
 * Caches credentials to .credentials/imap.json for reuse across runs.
 * Runs in the main process where stdin is available.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, ".credentials");
const CACHE_FILE = join(CACHE_DIR, "imap.json");

interface CachedCredentials {
  host: string;
  username: string;
  password: string;
  tls: "TLS" | "DISABLED";
}

async function loadCache(): Promise<CachedCredentials | undefined> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as CachedCredentials;
  } catch {
    return undefined;
  }
}

async function saveCache(creds: CachedCredentials): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(creds, null, 2) + "\n");
}

async function clearCache(): Promise<void> {
  try { await unlink(CACHE_FILE); } catch { /* already gone */ }
}

export async function setup() {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const cached = await loadCache();

    if (cached) {
      console.log(`\nCached credentials found: ${cached.username}@${cached.host}`);
      const answer = await rl.question("Clear credential cache? [y/N]: ");
      if (answer.toLowerCase() === "y") {
        await clearCache();
        console.log("Cache cleared.\n");
      } else {
        process.env.IMAP_HOST = cached.host;
        process.env.IMAP_USERNAME = cached.username;
        process.env.IMAP_PASSWORD = cached.password;
        process.env.IMAP_TLS = cached.tls;
        return;
      }
    }

    const host = await rl.question("IMAP host (e.g. imap.fastmail.com): ");
    const username = await rl.question("IMAP username: ");
    const password = await rl.question("IMAP password: ");
    const tlsRaw = await rl.question("TLS mode [TLS/DISABLED] (default: TLS): ");
    const tls = tlsRaw === "DISABLED" ? "DISABLED" as const : "TLS" as const;

    process.env.IMAP_HOST = host;
    process.env.IMAP_USERNAME = username;
    process.env.IMAP_PASSWORD = password;
    process.env.IMAP_TLS = tls;

    await saveCache({ host, username, password, tls });
    console.log("Credentials cached to .credentials/imap.json\n");
  } finally {
    rl.close();
  }
}
