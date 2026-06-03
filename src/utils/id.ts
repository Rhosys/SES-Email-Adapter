import { v7 as uuidv7 } from "uuid";
import shortUuid from "short-uuid";
import { createHash, randomBytes } from "node:crypto";

const translator = shortUuid.createTranslator(shortUuid.constants.flickrBase58);

const FLICKR_BASE58 = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const BASE58_SET = new Set(FLICKR_BASE58);

export function generateId(prefix: string): string {
  const uuid = uuidv7();
  const encoded = translator.fromUUID(uuid);
  const hash = createHash("sha256").update(encoded).digest("hex");
  const checkChars = hash.split("").filter(c => BASE58_SET.has(c)).slice(0, 3).join("");
  return `${prefix}${encoded}${checkChars}`;
}

export function validateId(id: string, prefix: string): boolean {
  if (!id.startsWith(prefix)) return false;
  const body = id.slice(prefix.length);

  // Body must be at least 4 chars (at least 1 char encoded + 3 check chars)
  if (body.length <= 3) return false;

  const encoded = body.slice(0, -3);
  const checkChars = body.slice(-3);

  // Recompute check chars
  const hash = createHash("sha256").update(encoded).digest("hex");
  const expectedCheckChars = hash.split("").filter(c => BASE58_SET.has(c)).slice(0, 3).join("");

  return checkChars === expectedCheckChars;
}

// ---------------------------------------------------------------------------
// Account IDs — different generation algorithm (lowercase alphanumeric + SHA-256 base64 check)
// ---------------------------------------------------------------------------

const ACCOUNT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ACCOUNT_ID_ALPHABET_SET = new Set(ACCOUNT_ID_ALPHABET);

export function generateAccountId(): string {
  const bytes = randomBytes(10);
  let rawId = "";
  for (let i = 0; i < 10; i++) {
    rawId += ACCOUNT_ID_ALPHABET[bytes[i]! % ACCOUNT_ID_ALPHABET.length];
  }
  const checkBits = createHash("sha256").update(rawId).digest("base64")
    .replace(/[^abcdefghijklmnopqrstuvwxyz0123456789]/g, "")
    .slice(0, 3);
  return `acc-${rawId}${checkBits}`;
}

export function validateAccountId(id: string): boolean {
  const prefix = "acc-";
  if (!id.startsWith(prefix)) return false;
  const body = id.slice(prefix.length);

  // Body should be 13 chars: 10 random + 3 check
  if (body.length !== 13) return false;

  // All chars must be lowercase alphanumeric
  for (const c of body) {
    if (!ACCOUNT_ID_ALPHABET_SET.has(c)) return false;
  }

  const rawId = body.slice(0, 10);
  const checkBits = body.slice(10);

  // Recompute check chars
  const expectedCheckBits = createHash("sha256").update(rawId).digest("base64")
    .replace(/[^abcdefghijklmnopqrstuvwxyz0123456789]/g, "")
    .slice(0, 3);

  return checkBits === expectedCheckBits;
}
