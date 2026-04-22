import { randomUUID, createHash } from "crypto";
import type { SESEvent } from "aws-lambda";
import { EmailClassifier } from "@ses-adapter/classifier";
import type { Email } from "@ses-adapter/shared";
import type { EmailStore } from "./store.js";
import type { MimeParser } from "./mime.js";

interface EmailProcessorOptions {
  store: EmailStore;
  mimeParser: MimeParser;
}

export class EmailProcessor {
  private readonly store: EmailStore;
  private readonly mimeParser: MimeParser;
  private readonly classifier: EmailClassifier;

  constructor({ store, mimeParser }: EmailProcessorOptions) {
    this.store = store;
    this.mimeParser = mimeParser;
    this.classifier = new EmailClassifier();
  }

  async process(event: SESEvent): Promise<void> {
    for (const record of event.Records) {
      try {
        await this.processRecord(record);
      } catch (err) {
        console.error(`Failed to process record ${record.ses.mail.messageId}:`, err);
      }
    }
  }

  private async processRecord(record: SESEvent["Records"][number]): Promise<void> {
    const { mail, receipt } = record.ses;
    const { messageId } = mail;

    const existing = await this.store.getEmailByMessageId(messageId);
    if (existing) return;

    const objectKey = receipt.action.objectKey;
    const parsed = await this.mimeParser.parse(objectKey);

    const classification = await this.classifier.classify({
      from: parsed.from.address,
      to: parsed.to.map((a) => a.address),
      subject: parsed.subject,
      textBody: parsed.textBody,
      htmlBody: parsed.htmlBody ?? undefined,
      headers: parsed.headers,
      receivedAt: mail.timestamp,
    });

    const threadId = subjectToThreadId(parsed.subject);

    const firstRecipient = parsed.to[0]?.address ?? mail.destination[0] ?? "";
    const atIndex = firstRecipient.indexOf("@");
    const recipientLocalPart = atIndex >= 0 ? firstRecipient.slice(0, atIndex) : firstRecipient;
    const recipientDomain = atIndex >= 0 ? firstRecipient.slice(atIndex + 1) : "";

    const now = new Date().toISOString();

    const email: Email = {
      id: randomUUID(),
      accountId: "",
      messageId,
      threadId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      receivedAt: mail.timestamp,
      attachments: parsed.attachments,
      category: classification.category,
      categoryData: classification.categoryData,
      spamScore: classification.spamScore,
      isValid: classification.isValid,
      summary: classification.summary,
      priority: classification.priority,
      recipientDomain,
      recipientLocalPart,
      isRead: false,
      isArchived: false,
      isTrashed: !classification.isValid,
      isStarred: false,
      labels: [],
      createdAt: now,
      updatedAt: now,
    };

    if (parsed.replyTo !== undefined) {
      email.replyTo = parsed.replyTo;
    }
    if (parsed.textBody !== undefined) {
      email.textBody = parsed.textBody;
    }
    if (parsed.htmlBody != null) {
      email.htmlBody = parsed.htmlBody;
    }
    if (parsed.sentAt !== undefined) {
      email.sentAt = parsed.sentAt;
    }

    await this.store.saveEmail(email);
  }
}

function subjectToThreadId(subject: string): string {
  const normalized = subject
    .replace(/^(Re|Fwd|Fw):\s*/gi, "")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
