import dns from "dns/promises";
import type { DnsRecord, Domain } from "../types/index.js";

const DKIM_SELECTOR = "mail";
const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "mail.ses-email-adapter.example.com";
const SES_INBOUND_ENDPOINT = process.env["SES_INBOUND_ENDPOINT"] ?? "inbound-smtp.eu-west-1.amazonaws.com";

async function resolveMx(name: string): Promise<string | undefined> {
  try {
    const records = await dns.resolveMx(name);
    const sorted = records.sort((a, b) => a.priority - b.priority);
    return sorted[0] ? `${sorted[0].priority} ${sorted[0].exchange}` : undefined;
  } catch {
    return undefined;
  }
}

async function resolveTxt(name: string): Promise<string | undefined> {
  try {
    const records = await dns.resolveTxt(name);
    return records.map((r) => r.join("")).find((r) => r.startsWith("v=spf1")) ?? records[0]?.join("") ?? undefined;
  } catch {
    return undefined;
  }
}

async function resolveCname(name: string): Promise<string | undefined> {
  try {
    const records = await dns.resolveCname(name);
    return records[0] ?? undefined;
  } catch {
    return undefined;
  }
}

function normalize(v: string): string {
  return v.trim().toLowerCase().replace(/\.+$/, "");
}

function matches(expected: string, current: string | undefined): boolean {
  if (current === undefined) return false;
  return normalize(expected) === normalize(current);
}

function toRecord(name: string, type: DnsRecord["type"], value: string, current: string | undefined): DnsRecord {
  const status: DnsRecord["status"] = matches(value, current) ? "verified" : current !== undefined ? "failing" : "pending";
  return current !== undefined
    ? { name, type, value, currentValue: current, status }
    : { name, type, value, status };
}

export async function checkDomain(domain: Domain): Promise<DnsRecord[]> {
  const d = domain.domain;
  const mxName = d;
  const dkimName = `${DKIM_SELECTOR}._domainkey.${d}`;
  const spfName = `bounce.${d}`;
  const dmarcName = `_dmarc.${d}`;

  const expectedMx = `10 ${SES_INBOUND_ENDPOINT}`;
  const expectedDkim = `${DKIM_SELECTOR}.${MAIL_DOMAIN}._domainkey.amazonses.com`;
  const expectedSpf = `v=spf1 include:amazonses.com ~all`;
  const expectedDmarc = `_dmarc.${MAIL_DOMAIN}`;

  const [mx, dkim, spf, dmarc] = await Promise.all([
    resolveMx(mxName),
    resolveCname(dkimName),
    resolveTxt(spfName),
    resolveCname(dmarcName),
  ]);

  return [
    toRecord(mxName,   "MX",    expectedMx,   mx),
    toRecord(dkimName, "CNAME", expectedDkim,  dkim),
    toRecord(spfName,  "TXT",   expectedSpf,   spf),
    toRecord(dmarcName,"CNAME", expectedDmarc, dmarc),
  ];
}
