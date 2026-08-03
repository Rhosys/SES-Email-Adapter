/**
 * Exploratory test: validates real IMAP connectivity using credentials
 * collected interactively via global-setup.ts.
 *
 * Run: npm run test:exploratory
 */

import { describe, it, expect } from "vitest";
import { ImapConnection } from "../src/external-exchanges/imap-adapter.js";

function createConnection() {
  return new ImapConnection({
    host: process.env.IMAP_HOST!,
    tlsConfig: (process.env.IMAP_TLS as "TLS" | "DISABLED") || "TLS",
    username: process.env.IMAP_USERNAME!,
    password: process.env.IMAP_PASSWORD!,
    timeout: 15_000,
  });
}

describe("IMAP connection (exploratory)", () => {
  it("connects and opens INBOX", async () => {
    const conn = createConnection();

    try {
      await conn.connect();
      const state = await conn.getInboxState();

      expect(state.uidvalidity).toBeGreaterThan(0);
      expect(state.uidNext).toBeGreaterThan(0);

      console.log("--- IMAP Connection Successful ---");
      console.log("Host:", process.env.IMAP_HOST);
      console.log("TLS:", process.env.IMAP_TLS || "TLS");
      console.log("UIDVALIDITY:", state.uidvalidity);
      console.log("UIDNEXT:", state.uidNext);
      console.log("Messages:", state.exists);
    } finally {
      await conn.logout();
    }
  });

  it("lists available mailboxes", async () => {
    const conn = createConnection();

    try {
      await conn.connect();
      const mailboxes = await conn.listMailboxes();

      console.log("--- Available Mailboxes ---");
      for (const mb of mailboxes) {
        console.log(` ${mb.path} (${mb.flags.join(", ") || "no flags"})`);
      }
      expect(mailboxes.length).toBeGreaterThan(0);
    } finally {
      await conn.logout();
    }
  });

  it("searches for new UIDs", async () => {
    const conn = createConnection();

    try {
      await conn.connect();
      const state = await conn.getInboxState();

      if (state.uidNext > 1) {
        // Search for the last known UID to confirm UID search works
        const lastUid = state.uidNext - 2;
        const newUids = await conn.searchNewUids(lastUid);
        console.log("--- UID Search ---");
        console.log("After UID:", lastUid);
        console.log("Found UIDs:", newUids.length > 10 ? `${newUids.length} UIDs (first 10: ${newUids.slice(0, 10).join(", ")})` : newUids);
      } else {
        console.log("INBOX is empty, skipping UID search");
      }
    } finally {
      await conn.logout();
    }
  });

  it("fetches first 10 emails from UID 1 with subject and sender", async () => {
    const conn = createConnection();

    try {
      await conn.connect();
      const envelopes = await conn.fetchEnvelopes(1, 10);

      console.log("--- First 10 Emails ---");
      for (const msg of envelopes) {
        console.log(`  UID ${msg.uid}: [${msg.from}] ${msg.subject}`);
      }
      expect(envelopes.length).toBeGreaterThan(0);
      expect(envelopes.length).toBeLessThanOrEqual(10);
    } finally {
      await conn.logout();
    }
  });
});
