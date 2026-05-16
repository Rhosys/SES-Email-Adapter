import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { DbError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Account, Domain } from "../types/index.js";
import type { OnboardingProgress } from "./compose-followup-email.js";
import { composeFollowupEmail } from "./compose-followup-email.js";

// ---------------------------------------------------------------------------
// Store interface — minimal surface needed by this handler
// ---------------------------------------------------------------------------

export interface OnboardingStore {
  getAccount(accountId: string): Promise<Result<Account | null, DbError>>;
  updateAccount(accountId: string, updates: { onboarding: { completed: boolean; completedAt?: string } }): Promise<Result<Account, DbError>>;
  listDomains(accountId: string): Promise<Result<Domain[], DbError>>;
  hasSignals(accountId: string): Promise<Result<boolean, DbError>>;
}

// ---------------------------------------------------------------------------
// OnboardingTaskHandler
// ---------------------------------------------------------------------------

export class OnboardingTaskHandler {
  constructor(
    private readonly store: OnboardingStore,
    private readonly logger: Logger,
  ) {}

  async handleFollowup(accountId: string, email: string): Promise<Result<void, DbError>> {
    return this.handleProgressTask(accountId, email, "onboarding.followup");
  }

  async handleCleanup(accountId: string, email: string): Promise<Result<void, DbError>> {
    return this.handleProgressTask(accountId, email, "onboarding.cleanup");
  }

  async handleTrialCheck(accountId: string): Promise<{ accountIsTrial: boolean }> {
    const accountResult = await this.store.getAccount(accountId);
    if (accountResult.isErr()) {
      throw new Error(`DynamoDB read failed for account ${accountId}: ${JSON.stringify(accountResult.error)}`);
    }

    const account = accountResult.value;
    if (!account) {
      return { accountIsTrial: false };
    }

    return { accountIsTrial: account.billingPlan === "Trial" };
  }

  // ---------------------------------------------------------------------------
  // Shared progress-check logic for followup and cleanup
  // ---------------------------------------------------------------------------

  private async handleProgressTask(accountId: string, email: string, code: string): Promise<Result<void, DbError>> {
    // 1. Read account
    const accountResult = await this.store.getAccount(accountId);
    if (accountResult.isErr()) {
      return err(accountResult.error);
    }
    const account = accountResult.value;
    if (!account) {
      this.logger.info("Account not found, skipping onboarding task", { code, accountId });
      return ok(undefined);
    }

    // 2. Query domains (failure → treat as incomplete)
    let domainAdded = false;
    let senderSetupComplete = false;
    const domainsResult = await this.store.listDomains(accountId);
    if (domainsResult.isOk()) {
      const domains = domainsResult.value;
      domainAdded = domains.length > 0;
      senderSetupComplete = domains.some(d => d.senderSetupComplete);
    } else {
      this.logger.warn("Failed to query domains, treating as incomplete", { code: code, accountId, error: domainsResult.error });
    }

    // 3. Query signals (failure → treat as incomplete)
    let emailsReceived = false;
    const signalsResult = await this.store.hasSignals(accountId);
    if (signalsResult.isOk()) {
      emailsReceived = signalsResult.value;
    } else {
      this.logger.warn("Failed to query signals, treating as incomplete", { code: code, accountId, error: signalsResult.error });
    }

    // 4. Compute progress
    const progress: OnboardingProgress = { domainAdded, senderSetupComplete, emailsReceived };

    // 5. If all complete and onboarding not yet marked → update account
    const allComplete = progress.domainAdded && progress.senderSetupComplete && progress.emailsReceived;
    if (allComplete && !account.onboarding?.completed) {
      const updateResult = await this.store.updateAccount(accountId, {
        onboarding: { completed: true, completedAt: new Date().toISOString() },
      });
      if (updateResult.isErr()) {
        return err(updateResult.error);
      }
    }

    // 6. Compose email content (for TRACK log — actual sending deferred to later)
    const emailContent = composeFollowupEmail(progress);

    // 7. Log TRACK with progress and composed email
    this.logger.track("Onboarding progress checked", {
      code: code,
      accountId,
      email,
      progress,
      emailContent,
    });

    return ok(undefined);
  }
}
