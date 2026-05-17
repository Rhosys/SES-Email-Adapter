import dns from "dns/promises";

export interface MxValidationResult {
  valid: boolean;
  invalidDomains: string[];
}

export async function validateRecipientMx(
  recipients: Array<{ address: string }>,
  timeoutMs: number = 2000,
): Promise<MxValidationResult> {
  const domains = [...new Set(recipients.map(r => r.address.split("@")[1]!))];
  const invalidDomains: string[] = [];

  await Promise.all(domains.map(async (domain) => {
    const hasMx = await resolveWithTimeout(domain, timeoutMs);
    if (!hasMx) invalidDomains.push(domain);
  }));

  return { valid: invalidDomains.length === 0, invalidDomains };
}

async function resolveWithTimeout(domain: string, timeoutMs: number): Promise<boolean> {
  try {
    const result = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (Array.isArray(result) && result.length > 0) return true;
    // Empty MX — fall through to A/AAAA fallback (RFC 5321 §5 implicit MX)
  } catch {
    // MX lookup failed — fall through to A/AAAA fallback
  }

  // Fallback: check A/AAAA record (RFC 5321 §5 implicit MX)
  try {
    const a = await Promise.race([
      dns.resolve4(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return Array.isArray(a) && a.length > 0;
  } catch {
    return false;
  }
}
