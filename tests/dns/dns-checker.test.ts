import { describe, it, expect, vi, beforeEach } from "vitest";
import dns from "dns/promises";
import { checkDomain } from "../../src/dns/dns-checker.js";
import type { Domain } from "../../src/types/index.js";

vi.mock("dns/promises");

const mockedDns = vi.mocked(dns);

function makeDomain(domain: string): Domain {
  return {
    accountId: "acc_test",
    domain,
    receivingSetupComplete: false,
    senderSetupComplete: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("checkDomain", () => {
  describe("MX matching ignores priority number", () => {
    it("marks MX as verified when exchange matches but priority differs (vortex.link scenario)", async () => {
      // vortex.link has MX priority 1 pointing to our server, plus a stale priority 10 record
      mockedDns.resolveMx.mockResolvedValue([
        { priority: 10, exchange: "inbound-smtp.us-east-1.amazonaws.com." },
        { priority: 1, exchange: "mx.platform.email.rhosys.cloud." },
      ]);
      mockedDns.resolveCname.mockResolvedValue(["placeholder.example.com"]);

      const records = await checkDomain(makeDomain("non-existent.example.domain"));
      const mx = records.find((r) => r.type === "MX");

      expect(mx).toBeDefined();
      expect(mx!.status).toBe("verified");
      expect(mx!.currentValue).toBe("1 mx.platform.email.rhosys.cloud.");
    });

    it("marks MX as verified when priority matches exactly", async () => {
      mockedDns.resolveMx.mockResolvedValue([
        { priority: 10, exchange: "mx.platform.email.rhosys.cloud." },
      ]);
      mockedDns.resolveCname.mockResolvedValue(["placeholder.example.com"]);

      const records = await checkDomain(makeDomain("example.com"));
      const mx = records.find((r) => r.type === "MX");

      expect(mx!.status).toBe("verified");
    });

    it("marks MX as failing when exchange hostname does not match", async () => {
      mockedDns.resolveMx.mockResolvedValue([
        { priority: 10, exchange: "mail.someother.com." },
      ]);
      mockedDns.resolveCname.mockResolvedValue(["placeholder.example.com"]);

      const records = await checkDomain(makeDomain("example.com"));
      const mx = records.find((r) => r.type === "MX");

      expect(mx!.status).toBe("failing");
      expect(mx!.currentValue).toBe("10 mail.someother.com.");
    });

    it("marks MX as pending when no MX records exist", async () => {
      mockedDns.resolveMx.mockRejectedValue(new Error("ENOTFOUND"));
      mockedDns.resolveCname.mockRejectedValue(new Error("ENOTFOUND"));

      const records = await checkDomain(makeDomain("nodns.example"));
      const mx = records.find((r) => r.type === "MX");

      expect(mx!.status).toBe("pending");
      expect(mx!.currentValue).toBeUndefined();
    });
  });
});
