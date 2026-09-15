import { simpleParser } from "mailparser";
import type { EmailAddress, Attachment } from "./types/index.js";
import type { ParsedMime } from "./processor/mime.js";
import { ok, err, dbError } from "./errors.js";
import type { DbError, Result } from "./errors.js";

export class MailparserMimeParser {
  async parse(rawEmail: Buffer | string): Promise<ParsedMime> {
    const parsed = await simpleParser(rawEmail);

    const toAddr = (addr: { address?: string | undefined; name?: string }): EmailAddress => ({
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

  async parseBuffer(rawEmail: Buffer | string): Promise<Result<ParsedMime, DbError>> {
    try {
      const result = await this.parse(rawEmail);
      return ok(result);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Extract the raw bytes of the first calendar (text/calendar or .ics) attachment
   * from a raw MIME message, or null when there is none. Lives here rather than in
   * a processor because MIME parsing is content parsing — it must stay outside the
   * src/processor/ boundary that forbids mailparser (ADR 011). Unlike parse(), this
   * keeps the attachment content (parse() deliberately discards it).
   */
  async extractCalendarAttachment(rawEmail: Buffer | string): Promise<Uint8Array | null> {
    const parsed = await simpleParser(rawEmail);
    for (const attachment of parsed.attachments) {
      const isCalendar =
        attachment.contentType.toLowerCase().startsWith("text/calendar") ||
        (attachment.filename?.toLowerCase().endsWith(".ics") ?? false);
      if (isCalendar) return new Uint8Array(attachment.content);
    }
    return null;
  }
}
