import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";

// ---------------------------------------------------------------------------
// Graph Encryption Certificate Module
//
// Manages registry of encryption keypairs keyed by encryptionCertificateId.
// Microsoft Graph requires an encryption certificate when using
// includeResourceData: true on subscriptions. The private key decrypts the
// symmetric key that Graph uses to encrypt notification payloads.
//
// We set includeResourceData: true for JWT verification tokens but DISCARD
// the encrypted content — we always fetch via API. The private key is only
// needed if we later decide to decrypt inline resource data.
//
// Only the KMS-encrypted private key (.kms) is committed. The public key is
// derived at runtime from the private key on the subscription creation path
// (lazy, cached after first call).
//
// Rotation: multiple keys in parallel keyed by encryptionCertificateId.
// The notification carries the cert ID for key selection. New subscriptions
// use the newest key; old keys remain deployed until confirmed unused (≤24h
// for Outlook renewals).
//
// See: https://learn.microsoft.com/en-us/graph/change-notifications-with-resource-data
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = join(__dirname, "..", "secrets");

const ACTIVE_CERT_ID = "numaeel-graph-v1";

// Lazy-loaded public key cache (derived from private key on first call)
let activeCertBase64: string | null = null;

// Lazy-loaded private key cache (KMS-decrypted)
const privateKeyCache = new Map<string, Buffer>();

/**
 * Returns the base64-encoded public key PEM for the active encryption certificate.
 * Derived lazily from the KMS-decrypted private key on the subscription creation path.
 * Cached after first call.
 */
export async function getActiveEncryptionCertificateBase64(): Promise<string> {
  if (activeCertBase64) return activeCertBase64;

  const privateKeyPem = await getPrivateKeyForCertId(ACTIVE_CERT_ID);
  const publicKey = createPublicKey(privateKeyPem);
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  activeCertBase64 = Buffer.from(publicPem).toString("base64");
  return activeCertBase64;
}

/**
 * Returns the encryptionCertificateId for the active certificate.
 * This is stored on the Graph subscription and included in each notification.
 */
export function getActiveEncryptionCertificateId(): string {
  return ACTIVE_CERT_ID;
}

/**
 * Returns the private key PEM for a given certificate ID, lazy-decrypted via KMS.
 * Supports multiple keys for rotation — the notification carries the cert ID.
 */
export async function getPrivateKeyForCertId(certId: string): Promise<Buffer> {
  const cached = privateKeyCache.get(certId);
  if (cached) return cached;

  // Map cert ID to file: "numaeel-graph-v1" → "graph-encryption-key-v1.kms"
  const version = certId.replace("numaeel-graph-", "");
  const kmsPath = join(SECRETS_DIR, `graph-encryption-key-${version}.kms`);
  const encrypted = readFileSync(kmsPath);

  const kms = new KMSClient({});
  const result = await kms.send(new DecryptCommand({
    CiphertextBlob: encrypted,
  }));

  if (!result.Plaintext) {
    throw new Error(`KMS decryption returned no plaintext for cert ${certId}`);
  }

  const key = Buffer.from(result.Plaintext);
  privateKeyCache.set(certId, key);
  return key;
}

// ---------------------------------------------------------------------------
// decryptSymmetricKey — commented out until we need inline resource data
// ---------------------------------------------------------------------------
//
// Graph encrypts notification resource data as follows:
// 1. Generates a random AES-256 symmetric key (dataKey)
// 2. Wraps dataKey with our RSA public key using RSA-OAEP (SHA-1)
// 3. Encrypts the resource data with AES-256-CBC + PKCS7 padding using dataKey
// 4. Base64-encodes the wrapped key as encryptedContent.dataKey
// 5. Base64-encodes the ciphertext as encryptedContent.data
// 6. Base64-encodes the IV as encryptedContent.dataSignature (misleading name)
//
// To decrypt:
// 1. RSA-OAEP unwrap the dataKey using our private key
// 2. AES-256-CBC decrypt the data using the unwrapped key + IV
// 3. PKCS7 unpad the plaintext
//
// import { privateDecrypt, createDecipheriv, constants } from "node:crypto";
//
// export async function decryptSymmetricKey(
//   encryptedDataKey: string,  // base64
//   certId: string,
// ): Promise<Buffer> {
//   const privateKey = await getPrivateKeyForCertId(certId);
//   const wrapped = Buffer.from(encryptedDataKey, "base64");
//   return privateDecrypt(
//     { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
//     wrapped,
//   );
// }
//
// export function decryptResourceData(
//   encryptedData: string,      // base64 ciphertext
//   dataSignature: string,      // base64 IV (misleading field name from Graph)
//   symmetricKey: Buffer,
// ): string {
//   const iv = Buffer.from(dataSignature, "base64");
//   const ciphertext = Buffer.from(encryptedData, "base64");
//   const decipher = createDecipheriv("aes-256-cbc", symmetricKey, iv);
//   const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
//   return plaintext.toString("utf-8");
// }
