import dns from "dns/promises";
import type { DnsRecord, Domain } from "../types/index.js";

const DKIM_SELECTOR = "mail";
const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";

async function resolveMx(name: string): Promise<string | undefined> {
  try {
    const records = await dns.resolveMx(name);
    const sorted = records.sort((a, b) => a.priority - b.priority);
    return sorted[0] ? `${sorted[0].priority} ${sorted[0].exchange}` : undefined;
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

/** MX match: ignore priority number, compare exchange hostname only */
function mxMatches(expected: string, current: string | undefined): boolean {
  if (current === undefined) return false;
  const expectedExchange = normalize(expected).replace(/^\d+\s+/, "");
  const currentExchange = normalize(current).replace(/^\d+\s+/, "");
  return expectedExchange === currentExchange;
}

function toRecord(name: string, type: DnsRecord["type"], value: string, current: string | undefined): DnsRecord {
  const isMatch = type === "MX" ? mxMatches(value, current) : matches(value, current);
  const status: DnsRecord["status"] = isMatch ? "verified" : current !== undefined ? "failing" : "pending";
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

  const expectedMx = `10 mx.${MAIL_DOMAIN}`;
  const expectedDkim = `${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN}`;
  const expectedSpf = `bounce.${MAIL_DOMAIN}`;
  const expectedDmarc = `_dmarc.${MAIL_DOMAIN}`;

  const [mx, dkim, spf, dmarc] = await Promise.all([
    resolveMx(mxName),
    resolveCname(dkimName),
    resolveCname(spfName),
    resolveCname(dmarcName),
  ]);

  return [
    toRecord(mxName,   "MX",    expectedMx,   mx),
    toRecord(dkimName, "CNAME", expectedDkim,  dkim),
    toRecord(spfName,  "CNAME", expectedSpf,   spf),
    toRecord(dmarcName,"CNAME", expectedDmarc, dmarc),
  ];
}
