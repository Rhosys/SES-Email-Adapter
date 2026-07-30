import type { EmailAddress, Attachment } from "../types/index.js";
import type { DbError, Result } from "../errors.js";

export interface ParsedMime {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  textBody?: string;
  htmlBody?: string | null;
  attachments: Attachment[];
  headers: Record<string, string>;
  sentAt?: string;
}

export interface MimeParser {
  parse(s3Key: string): Promise<Result<ParsedMime, DbError>>;
}

// MailparserMimeParser moved to src/mime-parser.ts (ADR 011: content parsing outside src/processor/)
export { MailparserMimeParser } from "../mime-parser.js";
