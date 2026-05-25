import { v7 as uuidv7 } from "uuid";
import { constants, createTranslator } from "short-uuid";
import { createHash } from "node:crypto";

const translator = createTranslator(constants.flickrBase58);

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
