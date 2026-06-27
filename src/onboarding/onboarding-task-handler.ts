import { ok, err } from "neverthrow";
import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";
import type { Result } from "neverthrow";
import type { DbError, TransientSesError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { EmailService } from "../email/email-service.js";
import type { Account, AccountOnboarding, Domain, ForwardingTarget } from "../types/index.js";
import type { OnboardingProgress } from "./compose-followup-email.js";
import { composeFollowupEmail } from "./compose-followup-email.js";
import { renderTemplate } from "../email/template-renderer.js";
import { buildEmailTags } from "../email/tag-sanitizer.js";
import { buildUnsubscribeHeaders } from "../email/unsubscribe-headers.js";
import { generateUnsubscribeToken } from "../email/unsubscribe-token.js";

// ---------------------------------------------------------------------------
// Store interfaces — one per backing class
// ---------------------------------------------------------------------------

export interface IOnboardingAccountDb {
  getAccount(accountId: string): Promise<Result<Account | null, DbError>>;
  updateAccount(accountId: string, updates: Partial<Pick<Account, "onboarding" | "digest" | "defaultCalendarInviteForwardingTargetId">>): Promise<Result<Account, DbError>>;
  listDomains(accountId: string): Promise<Result<Domain[], DbError>>;
  getForwardingTarget(accountId: string, target: string): Promise<Result<ForwardingTarget | null, DbError>>;
  saveForwardingTarget(target: ForwardingTarget): Promise<Result<void, DbError>>;
}

export interface IOnboardingArcDb {
  hasSignals(accountId: string): Promise<Result<boolean, DbError>>;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? ""
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? ""
const API_DOMAIN = process.env["API_DOMAIN"] ?? ""
const KMS_KEY_ARN = process.env["AUTHRESS_KMS_KEY_ARN"] ?? ""
const KEY_ID = process.env["AUTHRESS_KEY_ID"] ?? ""

// ---------------------------------------------------------------------------
// OnboardingTaskHandler
// ---------------------------------------------------------------------------

export class OnboardingTaskHandler {
  constructor(
    private readonly accountDb: IOnboardingAccountDb,
    private readonly arcDb: IOnboardingArcDb,
    private readonly logger: Logger,
    private readonly emailService: EmailService,
  ) {}

  async handleFollowup(accountId: string, email: string): Promise<Result<void, DbError | TransientSesError>> {
    // Auto-create verified forwarding target for the user's email (idempotent)
    await this.ensureDefaultForwardingTarget(accountId, email);
    return this.handleProgressTask(accountId, email, "onboarding.followup");
  }

  async handleCleanup(accountId: string, email: string): Promise<Result<void, DbError | TransientSesError>> {
    return this.handleProgressTask(accountId, email, "onboarding.cleanup");
  }

  async handleTrialCheck(accountId: string, executionStartTime: string): Promise<Result<{ accountIsTrial: boolean; trialExpired: boolean }, DbError>> {
    const accountResult = await this.accountDb.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    const account = accountResult.value;
    const accountIsTrial = account?.billingPlan === "Trial";
    const trialExpired = DateTime.utc().diff(DateTime.fromISO(executionStartTime), "days").days >= 60;
    if (accountIsTrial && trialExpired) {
      this.logger.track("Trial account still active after 60 days", { code: "onboarding.trial_check_expired", accountId });
    }
    return ok({ accountIsTrial, trialExpired });
  }

  // ---------------------------------------------------------------------------
  // Auto-create verified forwarding target + set digest/calendar defaults
  // ---------------------------------------------------------------------------

  private async ensureDefaultForwardingTarget(accountId: string, email: string): Promise<void> {
    const existingResult = await this.accountDb.getForwardingTarget(accountId, email);
    if (existingResult.isErr()) {
      this.logger.track("Failed to check existing forwarding target during onboarding — continuing without setup", { code: "onboarding.forwarding_target_check_failed", accountId, email, error: existingResult.error });
      return;
    }

    if (existingResult.value?.status === "verified") {
      // Target already exists and is verified — ensure account defaults are set
      await this.setAccountForwardingDefaults(accountId, email);
      return;
    }

    // Create verified target (we trust Authress as the identity source — no verification email needed)
    const now = DateTime.utc().toISO()!;
    const target: ForwardingTarget = {
      id: email,
      accountId,
      target: email,
      type: "email",
      status: "verified",
      token: randomUUID(),
      createdAt: now,
      verifiedAt: now,
    };

    const saveResult = await this.accountDb.saveForwardingTarget(target);
    if (saveResult.isErr()) {
      this.logger.track("Failed to create default forwarding target during onboarding — continuing without setup", { code: "onboarding.forwarding_target_save_failed", accountId, email, error: saveResult.error });
      return;
    }

    this.logger.info("Auto-created verified forwarding target from Authress email", { code: "onboarding.forwarding_target_created", accountId, email });
    await this.setAccountForwardingDefaults(accountId, email);
  }

  private async setAccountForwardingDefaults(accountId: string, forwardingTargetId: string): Promise<void> {
    const accountResult = await this.accountDb.getAccount(accountId);
    if (accountResult.isErr()) return;
    const account = accountResult.value;
    if (!account) return;

    // Only set defaults if not already configured
    const updates: Partial<Pick<Account, "digest" | "defaultCalendarInviteForwardingTargetId">> = {};
    if (!account.digest) {
      updates.digest = { frequency: "monthly", forwardingTargetId };
    }
    if (!account.defaultCalendarInviteForwardingTargetId) {
      updates.defaultCalendarInviteForwardingTargetId = forwardingTargetId;
    }

    if (Object.keys(updates).length === 0) return;

    const updateResult = await this.accountDb.updateAccount(accountId, updates);
    if (updateResult.isErr()) {
      this.logger.track("Failed to set account forwarding defaults during onboarding", { code: "onboarding.account_defaults_failed", accountId, forwardingTargetId, error: updateResult.error });
      return;
    }

    this.logger.info("Set account forwarding defaults", { code: "onboarding.account_defaults_set", accountId, forwardingTargetId, updates });
  }

  // ---------------------------------------------------------------------------
  // Shared progress-check logic for followup and cleanup
  // ---------------------------------------------------------------------------

  private async handleProgressTask(accountId: string, email: string, code: string): Promise<Result<void, DbError | TransientSesError>> {
    // 1. Read account
    const accountResult = await this.accountDb.getAccount(accountId);
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
    const domainsResult = await this.accountDb.listDomains(accountId);
    if (domainsResult.isOk()) {
      const domains = domainsResult.value;
      domainAdded = domains.length > 0;
      senderSetupComplete = domains.some(d => d.senderSetupComplete);
    } else {
      this.logger.warn("Failed to query domains, treating as incomplete", { code: code, accountId, error: domainsResult.error });
    }

    // 3. Query signals (failure → treat as incomplete)
    let emailsReceived = false;
    const signalsResult = await this.arcDb.hasSignals(accountId);
    if (signalsResult.isOk()) {
      emailsReceived = signalsResult.value;
    } else {
      this.logger.warn("Failed to query signals, treating as incomplete", { code: code, accountId, error: signalsResult.error });
    }

    // 4. Compute progress
    const progress: OnboardingProgress = { domainAdded, senderSetupComplete, emailsReceived };

    // 5. If emails received and testEmailReceived not yet marked → update account
    if (progress.emailsReceived && !account.onboarding?.testEmailReceived) {
      const updateResult = await this.accountDb.updateAccount(accountId, {
        onboarding: { ...account.onboarding!, testEmailReceived: true, testEmailReceivedAt: DateTime.utc().toISO()! },
      });
      if (updateResult.isErr()) {
        return err(updateResult.error);
      }
    }

    // 6. Suppress if all onboarding steps complete — no send needed
    if (progress.domainAdded && progress.senderSetupComplete && progress.emailsReceived) {
      this.logger.info("Onboarding email suppressed — all steps complete", { code, accountId });
      return ok(undefined);
    }

    // 7. Compose email content
    const emailContent = composeFollowupEmail(progress);

    // 8. Log TRACK with progress and composed email (before send — send is terminal)
    this.logger.track("Onboarding progress checked", {
      code: code,
      accountId,
      email,
      progress,
      emailContent,
    });

    // 9. Derive step from code for triggerId
    const step = code === "onboarding.followup" ? "followup" : "cleanup";
    const triggerId = `onboarding-${accountId}-${step}`;
    const fullDate = DateTime.utc().toISODate()!;

    // 10. Generate unsubscribe token
    const unsubscribeCode = await generateUnsubscribeToken({
      accountId,
      forwardingTargetId: accountId,
      emailType: "onboarding",
      apiDomain: API_DOMAIN,
      kmsKeyArn: KMS_KEY_ARN,
      keyId: KEY_ID,
    });

    // 11. Render template
    const htmlBody = await renderTemplate("onboarding-followup", {
      domainAdded: progress.domainAdded,
      senderSetupComplete: progress.senderSetupComplete,
      emailsReceived: progress.emailsReceived,
      domainIcon: progress.domainAdded ? "✅" : "❌",
      senderIcon: progress.senderSetupComplete ? "✅" : "❌",
      emailsIcon: progress.emailsReceived ? "✅" : "❌",
      unsubscribeCode,
      domain: APP_BASE_URL.replace(/^https?:\/\//, ""),
      emailType: "onboarding",
      appBaseUrl: APP_BASE_URL,
    });

    // 12. Build tags and headers
    const tags = buildEmailTags({
      accountId,
      fullDate,
      invocationId: this.logger.getInvocationId(),
      triggerId,
    });
    const headers = buildUnsubscribeHeaders(accountId, API_DOMAIN, unsubscribeCode);

    // 13. Send via EmailService — terminal operation, no DB writes after send
    const textBody = `${emailContent.textBody}\n\nView your account: ${APP_BASE_URL}/a/`;
    const sendResult = await this.emailService.send({
      to: email,
      subject: "The Next Step",
      textBody,
      htmlBody,
      headers,
      tags,
      fromOverride: `"Numaeel" <noreply@${MAIL_DOMAIN}>`,
      accountId,
    });

    if (sendResult.isErr()) return err(sendResult.error);

    return ok(undefined);
  }
}
