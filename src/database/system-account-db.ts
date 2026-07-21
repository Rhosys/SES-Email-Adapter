import { ok } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Account, Domain, Alias, Rule } from "../types/index.js";
import { SYSTEM_RULES } from "../processor/system-rules.js";

export const SYSTEM_ACCOUNT_ID = "SYSTEM";

export function isSystemAccount(accountId: string): boolean {
  return accountId === SYSTEM_ACCOUNT_ID;
}

/**
 * Provides hardcoded responses for the SYSTEM account.
 * AccountDatabase delegates to this class when isSystemAccount(accountId) is true.
 *
 * The SYSTEM account is used by the daily healthcheck. Its signals/threads are
 * stored normally in DynamoDB (needed for validation), but account-config lookups
 * (rules, filtering, domains, aliases) are short-circuited here.
 */
export class SystemAccountDb {
  private readonly mailDomain: string;
  private readonly healthcheckAddress: string;
  private readonly healthcheckSubdomain: string;
  private readonly healthcheckSubdomainAddress: string;

  constructor(mailDomain: string) {
    this.mailDomain = mailDomain;
    this.healthcheckAddress = `healthcheck@${mailDomain}`;
    this.healthcheckSubdomain = `healthcheck.${mailDomain}`;
    this.healthcheckSubdomainAddress = `healthcheck@healthcheck.${mailDomain}`;
  }

  getAccount(): Result<Account, DbError> {
    return ok({
      id: SYSTEM_ACCOUNT_ID,
      name: "System",
      retentionDuration: "P7D" as const,
      filtering: { defaultUnknownSenderPolicy: "allow_all" as const },
      digest: null,
      onboarding: { completed: true },
      // The SYSTEM account holds only 7-day throwaway healthcheck mail — not a
      // paying customer. It must not carry a copy-to-saved tier (e.g. Internal),
      // which would preserve daily healthcheck emails in S3 indefinitely.
      billingPlan: "Free" as const,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
  }

  listEnabledRules(): Result<Rule[], DbError> {
    return ok(SYSTEM_RULES.filter(r => r.status === "enabled"));
  }

  getDomainByName(domainName: string): Result<Domain | null, DbError> {
    if (domainName === this.mailDomain) {
      return ok({
        accountId: SYSTEM_ACCOUNT_ID,
        domain: this.mailDomain,
        receivingSetupComplete: true,
        senderSetupComplete: true,
        receivingHealthy: true,
        senderHealthy: true,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      });
    }
    if (domainName === this.healthcheckSubdomain) {
      return ok({
        accountId: SYSTEM_ACCOUNT_ID,
        domain: this.healthcheckSubdomain,
        receivingSetupComplete: true,
        senderSetupComplete: true,
        receivingHealthy: true,
        senderHealthy: true,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      });
    }
    return ok(null);
  }

  getDomainOwner(domain: string): Result<Domain | null, DbError> {
    return this.getDomainByName(domain);
  }

  getAliasByGlobalAddress(recipientAddress: string): Result<Alias | null, DbError> {
    if (recipientAddress === this.healthcheckAddress) {
      return ok({
        id: "system-healthcheck",
        accountId: SYSTEM_ACCOUNT_ID,
        aliasAddress: this.healthcheckAddress,
        domain: this.mailDomain,
        aliasName: "healthcheck",
        unknownSenderPolicy: "allow_all" as const,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      });
    }
    if (recipientAddress === this.healthcheckSubdomainAddress) {
      return ok({
        id: "system-healthcheck-subdomain",
        accountId: SYSTEM_ACCOUNT_ID,
        aliasAddress: this.healthcheckSubdomainAddress,
        domain: this.healthcheckSubdomain,
        aliasName: "healthcheck",
        unknownSenderPolicy: "allow_all" as const,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      });
    }
    return ok(null);
  }

  listDomains(): Result<Domain[], DbError> {
    return ok([{
      accountId: SYSTEM_ACCOUNT_ID,
      domain: this.mailDomain,
      receivingSetupComplete: true,
      senderSetupComplete: true,
      receivingHealthy: true,
      senderHealthy: true,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    }, {
      accountId: SYSTEM_ACCOUNT_ID,
      domain: this.healthcheckSubdomain,
      receivingSetupComplete: true,
      senderSetupComplete: true,
      receivingHealthy: true,
      senderHealthy: true,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    }]);
  }

  // Empty/default responses for all other lookups
  listAliases(): Result<Alias[], DbError> { return ok([]); }
  listRules(): Result<Rule[], DbError> { return ok(SYSTEM_RULES); }
  listForwardingTargets(): Result<never[], DbError> { return ok([]); }
  listTemplates(): Result<never[], DbError> { return ok([]); }
  getSender(): Result<null, DbError> { return ok(null); }
}
