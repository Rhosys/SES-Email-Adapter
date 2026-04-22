import { simpleParser } from "mailparser";
import type { EmailAddress, Attachment } from "@ses-adapter/shared";

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
  parse(rawEmail: Buffer | string): Promise<ParsedMime>;
}

export class MailparserMimeParser implements MimeParser {
  async parse(rawEmail: Buffer | string): Promise<ParsedMime> {
    const parsed = await simpleParser(rawEmail);

    const toAddressObject = (addr: { address?: string; name?: string }): EmailAddress => ({
      address: addr.address ?? "",
      name: addr.name,
    });

    const from: EmailAddress = parsed.from?.value[0]
      ? toAddressObject(parsed.from.value[0])
      : { address: "" };

    const to: EmailAddress[] = (parsed.to
      ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
      : []
    ).flatMap((a) => a.value.map(toAddressObject));

    const cc: EmailAddress[] = (parsed.cc
      ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
      : []
    ).flatMap((a) => a.value.map(toAddressObject));

    const attachments: Attachment[] = parsed.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      mimeType: a.contentType,
      sizeBytes: a.size,
      s3Key: "",        // Filled in by processor after uploading to S3
      contentId: a.contentId ?? undefined,
    }));

    const headers: Record<string, string> = {};
    parsed.headers.forEach((value, key) => {
      headers[key] = typeof value === "string" ? value : JSON.stringify(value);
    });

    return {
      from,
      to,
      cc,
      replyTo: parsed.replyTo?.value[0] ? toAddressObject(parsed.replyTo.value[0]) : undefined,
      subject: parsed.subject ?? "(no subject)",
      textBody: parsed.text ?? undefined,
      htmlBody: parsed.html || null,
      attachments,
      headers,
      sentAt: parsed.date?.toISOString(),
    };
  }
}
