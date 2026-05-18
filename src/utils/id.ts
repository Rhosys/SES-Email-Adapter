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
