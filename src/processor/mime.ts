import { simpleParser } from "mailparser";
import type { EmailAddress, Attachment } from "../types/index.js";

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
  parse(s3Key: string): Promise<ParsedMime>;
}

export class MailparserMimeParser {
  async parse(rawEmail: Buffer | string): Promise<ParsedMime> {
    const parsed = await simpleParser(rawEmail);

    const toAddr = (addr: { address?: string; name?: string }): EmailAddress => ({
      address: addr.address ?? "",
      ...(addr.name ? { name: addr.name } : {}),
    });

    const from: EmailAddress = parsed.from?.value[0]
      ? toAddr(parsed.from.value[0])
      : { address: "" };

    const to: EmailAddress[] = (
      parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : []
    ).flatMap((a) => a.value.map(toAddr));

    const cc: EmailAddress[] = (
      parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : []
    ).flatMap((a) => a.value.map(toAddr));

    const attachments: Attachment[] = parsed.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      mimeType: a.contentType,
      sizeBytes: a.size,
      s3Key: "",
      ...(a.contentId ? { contentId: a.contentId } : {}),
    }));

    const headers: Record<string, string> = {};
    parsed.headers.forEach((value, key) => {
      headers[key] = typeof value === "string" ? value : JSON.stringify(value);
    });

    return {
      from,
      to,
      cc,
      ...(parsed.replyTo?.value[0] ? { replyTo: toAddr(parsed.replyTo.value[0]) } : {}),
      subject: parsed.subject ?? "(no subject)",
      ...(parsed.text !== undefined ? { textBody: parsed.text } : {}),
      htmlBody: parsed.html || null,
      attachments,
      headers,
      ...(parsed.date ? { sentAt: parsed.date.toISOString() } : {}),
    };
  }
}
