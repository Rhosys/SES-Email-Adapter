// ---------------------------------------------------------------------------
// Digest Worker
// Receives `digest_send` SQS message, re-validates frequency, queries top
// active threads, counts quarantined signals, renders template, sends via
// EmailService. Terminal operation — no post-send writes.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon"

import { ok, err } from "../errors.js"
import type { DbError, Result } from "../errors.js"
import type { EmailServiceError } from "../email/email-service.js"
import type { Logger } from "../logger.js"
import type { EmailService } from "../email/email-service.js"
import type { AccountDatabase } from "../database/account-database.js"
import type { ThreadDatabase } from "../database/thread-database.js"
import { shouldDispatchDigest, buildDigestSubject } from "./digest-frequency-filter.js"
import type { DigestFrequency } from "./digest-frequency-filter.js"
import type { UnsubscribeTokenGenerator } from "../email/unsubscribe-token-generator.js"
import { renderTemplate } from "../email/template-renderer.js"
import { getEmailTheme } from "../email/email-theme.js"
import { buildEmailTags } from "../email/tag-sanitizer.js"
import { buildUnsubscribeHeaders } from "../email/unsubscribe-headers.js"
import { mapThreadToCard } from "./digest-data-mapper.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IDigestSendMessage {
  accountId: string
}

export interface IDigestWorkerDeps {
  accountDb: AccountDatabase
  threadDb: ThreadDatabase
  signalDb: ThreadDatabase
  emailService: EmailService
  unsubscribeTokenGenerator: UnsubscribeTokenGenerator
  logger: Logger
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? ""
const API_DOMAIN = process.env["API_DOMAIN"] ?? ""

export class DigestWorker {
  private readonly deps: IDigestWorkerDeps

  constructor(deps: IDigestWorkerDeps) {
    this.deps = deps
  }

  async process(message: IDigestSendMessage, today: DateTime = DateTime.utc()): Promise<Result<void, DbError | EmailServiceError>> {
    const { accountDb, threadDb, signalDb, emailService, logger } = this.deps
    const { accountId } = message

    // 1. Load account
    const accountResult = await accountDb.getAccount(accountId)
    if (accountResult.isErr()) return err(accountResult.error)
    const account = accountResult.value
    if (!account) {
      logger.info("Digest suppressed — account not found", { code: "digest.worker.account_not_found", accountId })
      return ok(undefined)
    }

    // 2. Verify digest still enabled
    if (!account.digest) {
      logger.info("Digest suppressed — digest disabled or never configured", { code: "digest.worker.digest_disabled", accountId })
      return ok(undefined)
    }

    // 3. Re-validate frequency against today (guard stale retries)
    const frequency = account.digest.frequency
    if (!shouldDispatchDigest(frequency as DigestFrequency, today)) {
      logger.info("Digest suppressed — frequency mismatch on retry", { code: "digest.worker.frequency_mismatch", accountId, frequency })
      return ok(undefined)
    }

    // 4. Resolve forwardingTarget → get verified email address
    const targetResult = await accountDb.getForwardingTarget(accountId, account.digest.forwardingTargetId)
    if (targetResult.isErr()) return err(targetResult.error)
    const target = targetResult.value
    if (!target || target.status !== "verified") {
      logger.warn("Digest suppressed — forwarding target not found or unverified", {
        code: "digest.worker.target_invalid",
        accountId,
        forwardingTargetId: account.digest.forwardingTargetId,
      })
      return ok(undefined)
    }

    // 5. Query top 100 active threads (sorted by lastSignalAt desc)
    const threadsResult = await threadDb.listActiveThreads(accountId, 100)
    if (threadsResult.isErr()) return err(threadsResult.error)
    const threads = threadsResult.value

    // 6. Count visible quarantined signals
    const quarantineResult = await signalDb.listPreThreadSignals(accountId, "quarantined", { limit: 100 })
    if (quarantineResult.isErr()) return err(quarantineResult.error)
    const quarantineCount = quarantineResult.value.items.filter(s => s.status === "quarantine_visible").length

    // Suppress if nothing to report
    if (threads.length === 0 && quarantineCount === 0) {
      logger.info("Digest suppressed — zero active threads and zero visible quarantine", { code: "digest.worker.nothing_to_report", accountId })
      return ok(undefined)
    }

    // 7. Fetch latest signal per thread for workflow detail (parallel, best-effort)
    const theme = getEmailTheme()
    const cardResults = await Promise.all(
      threads.map(async (thread) => {
        const signalsResult = await threadDb.listSignals(accountId, thread.id, { limit: 1 })
        const latestSignal = signalsResult.isOk() ? signalsResult.value.items[0] ?? null : null
        return mapThreadToCard({
          thread,
          latestSignal,
          appBaseUrl: emailService.appBaseUrl,
          theme,
        })
      }),
    )

    // 8. Generate unsubscribe JWT
    const unsubscribeCode = await this.deps.unsubscribeTokenGenerator.generate({ accountId, emailType: "digest" })

    // 9. Render digest template
    const subject = buildDigestSubject(frequency as DigestFrequency, today)
    const fullDate = today.toISODate()!
    const htmlBody = await renderTemplate("digest", {
      cards: cardResults,
      hasThreads: cardResults.length > 0,
      threadCount: cardResults.length,
      quarantineCount,
      hasQuarantine: quarantineCount > 0,
      unsubscribeCode,
      domain: emailService.appDomain,
      emailType: "digest",
      appBaseUrl: emailService.appBaseUrl,
      subject,
    })

    // 10. Build tags and headers
    const triggerId = `digest-${accountId}-${fullDate}`
    const tags = buildEmailTags({
      accountId,
      fullDate,
      invocationId: logger.getInvocationId(),
      triggerId,
    })
    const headers = buildUnsubscribeHeaders(accountId, API_DOMAIN, unsubscribeCode)

    // 11. Send via EmailService — terminal operation, no post-send writes
    const textBody = `Your ${frequency} Numaeel digest is ready. ${threads.length} active conversations.${quarantineCount > 0 ? ` ${quarantineCount} emails awaiting review in quarantine.` : ""} View your dashboard: ${emailService.appBaseUrl}/a/`

    // Resolve sender domain: prefer customer's own domain if sender setup is complete
    const domainsResult = await accountDb.listDomains(accountId)
    const senderDomain = domainsResult.isOk()
      ? domainsResult.value.find(d => d.senderSetupComplete && d.status !== "deleted")
      : null
    const fromDomain = senderDomain ? senderDomain.domain : MAIL_DOMAIN
    const sendAccountId = senderDomain ? accountId : emailService.platformTenant

    const sendResult = await emailService.send({
      to: target.target,
      subject,
      textBody,
      htmlBody,
      headers,
      tags,
      fromOverride: `"Numaeel Digest" <digest@${fromDomain}>`,
      accountId: sendAccountId,
    })

    if (sendResult.isErr()) {
      if (sendResult.error.kind === "permanent_ses_error") {
        logger.warn("Digest send permanently rejected by SES — will not retry.", { code: "digest.worker.send_permanent", accountId, error: sendResult.error })
        return ok(undefined)
      }
      return err(sendResult.error)
    }

    logger.info("Digest sent", {
      code: "digest.worker.sent",
      accountId,
      messageId: sendResult.value.messageId,
      threadCount: threads.length,
      quarantineCount,
    })

    return ok(undefined)
  }
}
