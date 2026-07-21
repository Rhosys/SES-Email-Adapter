import { describe, it, expect } from "vitest";
import { SystemAccountDb, SYSTEM_ACCOUNT_ID, isSystemAccount } from "../../src/database/system-account-db.js";
import { SYSTEM_RULES } from "../../src/processor/system-rules.js";

const MAIL_DOMAIN = "platform.email.rhosys.cloud";
const db = new SystemAccountDb(MAIL_DOMAIN);

describe("SystemAccountDb", () => {
  describe("isSystemAccount", () => {
    it("returns true for SYSTEM", () => {
      expect(isSystemAccount("SYSTEM")).toBe(true);
    });

    it("returns false for other account IDs", () => {
      expect(isSystemAccount("acct-123")).toBe(false);
      expect(isSystemAccount("")).toBe(false);
      expect(isSystemAccount("system")).toBe(false);
    });
  });

  describe("getAccount", () => {
    it("returns Account with id SYSTEM and billing plan Free", () => {
      const result = db.getAccount();
      expect(result.isOk()).toBe(true);

      const account = result._unsafeUnwrap();
      expect(account.id).toBe(SYSTEM_ACCOUNT_ID);
      expect(account.billingPlan).toBe("Free");
      expect(account.filtering?.defaultUnknownSenderPolicy).toBe("allow_all");
      expect(account.digest).toBeNull();
      expect(account.retentionDuration).toBe("P7D");
      expect(account.onboarding?.completed).toBe(true);
    });
  });

  describe("listEnabledRules", () => {
    it("returns only enabled system rules", () => {
      const result = db.listEnabledRules();
      expect(result.isOk()).toBe(true);

      const rules = result._unsafeUnwrap();
      const expectedEnabled = SYSTEM_RULES.filter(r => r.status === "enabled");
      expect(rules).toHaveLength(expectedEnabled.length);
      expect(rules.every(r => r.status === "enabled")).toBe(true);
      expect(rules.every(r => r.accountId === "SYSTEM")).toBe(true);
    });
  });

  describe("getDomainByName", () => {
    it("returns domain for MAIL_DOMAIN", () => {
      const result = db.getDomainByName(MAIL_DOMAIN);
      expect(result.isOk()).toBe(true);

      const domain = result._unsafeUnwrap();
      expect(domain).not.toBeNull();
      expect(domain!.domain).toBe(MAIL_DOMAIN);
      expect(domain!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(domain!.receivingSetupComplete).toBe(true);
      expect(domain!.senderSetupComplete).toBe(true);
    });

    it("returns domain for healthcheck subdomain with setup complete", () => {
      const result = db.getDomainByName(`healthcheck.${MAIL_DOMAIN}`);
      expect(result.isOk()).toBe(true);

      const domain = result._unsafeUnwrap();
      expect(domain).not.toBeNull();
      expect(domain!.domain).toBe(`healthcheck.${MAIL_DOMAIN}`);
      expect(domain!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(domain!.receivingSetupComplete).toBe(true);
      expect(domain!.senderSetupComplete).toBe(true);
    });

    it("returns null for other domains", () => {
      const result = db.getDomainByName("example.com");
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe("getAliasByGlobalAddress", () => {
    it("resolves healthcheck@MAIL_DOMAIN to SYSTEM alias", () => {
      const result = db.getAliasByGlobalAddress(`healthcheck@${MAIL_DOMAIN}`);
      expect(result.isOk()).toBe(true);

      const alias = result._unsafeUnwrap();
      expect(alias).not.toBeNull();
      expect(alias!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(alias!.aliasAddress).toBe(`healthcheck@${MAIL_DOMAIN}`);
      expect(alias!.domain).toBe(MAIL_DOMAIN);
      expect(alias!.unknownSenderPolicy).toBe("allow_all");
    });

    it("resolves healthcheck@healthcheck.MAIL_DOMAIN to SYSTEM alias on subdomain", () => {
      const result = db.getAliasByGlobalAddress(`healthcheck@healthcheck.${MAIL_DOMAIN}`);
      expect(result.isOk()).toBe(true);

      const alias = result._unsafeUnwrap();
      expect(alias).not.toBeNull();
      expect(alias!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(alias!.aliasAddress).toBe(`healthcheck@healthcheck.${MAIL_DOMAIN}`);
      expect(alias!.domain).toBe(`healthcheck.${MAIL_DOMAIN}`);
      expect(alias!.unknownSenderPolicy).toBe("allow_all");
    });

    it("returns null for non-healthcheck addresses", () => {
      const result = db.getAliasByGlobalAddress(`other@${MAIL_DOMAIN}`);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe("other methods return empty/default", () => {
    it("listDomains returns both platform and healthcheck domains", () => {
      const result = db.listDomains();
      expect(result.isOk()).toBe(true);

      const domains = result._unsafeUnwrap();
      expect(domains).toHaveLength(2);
      expect(domains[0]!.domain).toBe(MAIL_DOMAIN);
      expect(domains[0]!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(domains[1]!.domain).toBe(`healthcheck.${MAIL_DOMAIN}`);
      expect(domains[1]!.accountId).toBe(SYSTEM_ACCOUNT_ID);
    });

    it("listAliases returns empty array", () => {
      const result = db.listAliases();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it("listForwardingTargets returns empty array", () => {
      const result = db.listForwardingTargets();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it("listTemplates returns empty array", () => {
      const result = db.listTemplates();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it("getSender returns null", () => {
      const result = db.getSender();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("getDomainOwner returns domain for MAIL_DOMAIN", () => {
      const result = db.getDomainOwner(MAIL_DOMAIN);
      expect(result.isOk()).toBe(true);
      const domain = result._unsafeUnwrap();
      expect(domain).not.toBeNull();
      expect(domain!.accountId).toBe(SYSTEM_ACCOUNT_ID);
    });

    it("getDomainOwner returns null for other domains", () => {
      const result = db.getDomainOwner("example.com");
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });
});
