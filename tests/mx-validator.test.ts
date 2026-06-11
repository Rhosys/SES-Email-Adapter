import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("dns/promises", () => ({
  default: {
    resolveMx: vi.fn(),
    resolve4: vi.fn(),
  },
}));

import dns from "dns/promises";
import { validateRecipientMx } from "../src/dns/mx-validator.js";

const mockResolveMx = vi.mocked(dns.resolveMx);
const mockResolve4 = vi.mocked(dns.resolve4);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("validateRecipientMx", () => {
  describe("domain extraction", () => {
    it("extracts unique domains from recipient addresses", async () => {
      mockResolveMx.mockResolvedValue([{ exchange: "mx.example.com", priority: 10 }]);

      const promise = validateRecipientMx([
        { address: "alice@example.com" },
        { address: "bob@example.com" },
        { address: "carol@other.org" },
      ]);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isOk()).toBe(true);
      // Should only resolve 2 unique domains, not 3
      expect(mockResolveMx).toHaveBeenCalledTimes(2);
      expect(mockResolveMx).toHaveBeenCalledWith("example.com");
      expect(mockResolveMx).toHaveBeenCalledWith("other.org");
    });
  });

  describe("MX resolution", () => {
    it("returns valid when all domains have MX records", async () => {
      mockResolveMx.mockResolvedValue([{ exchange: "mx.example.com", priority: 10 }]);

      const promise = validateRecipientMx([{ address: "user@example.com" }]);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isOk()).toBe(true);
    });

    it("returns invalid when a domain has no MX and no A record", async () => {
      mockResolveMx.mockRejectedValue(new Error("ENOTFOUND"));
      mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));

      const promise = validateRecipientMx([{ address: "user@nonexistent.invalid" }]);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().invalidDomains).toEqual(["nonexistent.invalid"]);
    });

    it("returns invalid when MX resolves to empty array and A also fails", async () => {
      mockResolveMx.mockResolvedValue([]);
      mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));

      const promise = validateRecipientMx([{ address: "user@empty-mx.test" }]);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().invalidDomains).toEqual(["empty-mx.test"]);
    });
  });

  describe("A/AAAA fallback (RFC 5321 §5 implicit MX)", () => {
    it("falls back to A record when MX lookup fails", async () => {
      mockResolveMx.mockRejectedValue(new Error("ENOTFOUND"));
      mockResolve4.mockResolvedValue(["93.184.216.34"]);

      const promise = validateRecipientMx([{ address: "user@a-only.example" }]);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isOk()).toBe(true);
      expect(mockResolve4).toHaveBeenCalledWith("a-only.example");
    });

    it("falls back to A record when MX returns empty array", async () => {
      mockResolveMx.mockResolvedValue([]);
      mockResolve4.mockResolvedValue(["1.2.3.4"]);

      const promise = validateRecipientMx([{ address: "user@no-mx.example" }]);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isOk()).toBe(true);
    });
  });

  describe("timeout handling", () => {
    it("treats MX timeout as failure and falls back to A record", async () => {
      mockResolveMx.mockImplementation(() => new Promise(() => {})); // never resolves
      mockResolve4.mockResolvedValue(["1.2.3.4"]);

      const promise = validateRecipientMx([{ address: "user@slow.example" }], 500);
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result.isOk()).toBe(true);
    });

    it("treats both MX and A timeout as invalid domain", async () => {
      mockResolveMx.mockImplementation(() => new Promise(() => {})); // never resolves
      mockResolve4.mockImplementation(() => new Promise(() => {})); // never resolves

      const promise = validateRecipientMx([{ address: "user@timeout.example" }], 500);
      await vi.advanceTimersByTimeAsync(1000); // enough for both timeouts
      const result = await promise;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().invalidDomains).toEqual(["timeout.example"]);
    });
  });

  describe("mixed domains", () => {
    it("reports only invalid domains when some succeed and some fail", async () => {
      mockResolveMx.mockImplementation(async (domain) => {
        if (domain === "good.com") return [{ exchange: "mx.good.com", priority: 10 }];
        throw new Error("ENOTFOUND");
      });
      mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));

      const promise = validateRecipientMx([
        { address: "alice@good.com" },
        { address: "bob@bad.invalid" },
      ]);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().invalidDomains).toEqual(["bad.invalid"]);
    });
  });
});
