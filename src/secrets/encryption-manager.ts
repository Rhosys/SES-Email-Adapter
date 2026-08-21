import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { Logger } from "../logger.js";
import encryptionSecret from "./encryption.kms.json" with { type: "json" };

export type EncryptionError =
  | { kind: "kms_unavailable"; cause: unknown }
  | { kind: "crypto_failed"; cause: unknown };

/**
 * Owns the KMS-derived encryption key. All cryptographic operations (encrypt, decrypt, hash)
 * are exposed as methods — the key material MUST NEVER be exported, returned, or made
 * accessible to other classes. Callers pass data in, get results out.
 *
 * All operations return `Result` — no method throws. The async methods self-heal by
 * re-attempting KMS decrypt on first use.
 */
export class EncryptionManager {
  private key: Buffer | null = null;
  private initPromise: Promise<Result<Buffer, EncryptionError>> | null = null;

  constructor(private readonly kms: KMSClient, private readonly logger: Logger) {}

  /**
   * Fire-and-forget safe — catches internally and logs. Subsequent calls to the async
   * methods will re-attempt init if it failed or hasn't completed.
   */
  async init(): Promise<void> {
    const result = await this.ensureReady();
    if (result.isErr()) {
      this.logger.warn("[EncryptionManager] KMS init failed — operations will retry on first use", { code: "encryption.init_failed", error: result.error });
    }
  }

  /** Loads the key via KMS. Never throws — returns a Result. Memoises the in-flight promise. */
  private ensureReady(): Promise<Result<Buffer, EncryptionError>> {
    if (this.key) return Promise.resolve(ok(this.key));
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<Result<Buffer, EncryptionError>> {
    try {
      const ciphertext = Buffer.from(encryptionSecret.ciphertext, "base64");
      const result = await this.kms.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
      const key = Buffer.from(result.Plaintext!);
      this.key = key;
      return ok(key);
    } catch (e) {
      // Reset so a later call retries KMS rather than replaying the failed promise
      this.initPromise = null;
      if (e instanceof Error && e.name === "InvalidCiphertextException") {
        this.logger.critical("[EncryptionManager] encryption.kms.json contains invalid ciphertext — re-encrypt with the correct KMS key using kms-encrypt tool", { code: "encryption.invalid_ciphertext", error: e });
      }
      return err({ kind: "kms_unavailable", cause: e });
    }
  }

  /** Ensures the key is loaded (retries KMS if needed), then encrypts. */
  async encrypt(plaintext: string): Promise<Result<string, EncryptionError>> {
    const ready = await this.ensureReady();
    if (ready.isErr()) return err(ready.error);
    return this.doEncrypt(ready.value, plaintext);
  }

  /** Ensures the key is loaded (retries KMS if needed), then decrypts. */
  async decrypt(encoded: string): Promise<Result<string, EncryptionError>> {
    const ready = await this.ensureReady();
    if (ready.isErr()) return err(ready.error);
    return this.doDecrypt(ready.value, encoded);
  }

  /** HMAC-SHA256 keyed hash — returns base64url (no padding). Ensures key is loaded first. */
  async hash(data: string): Promise<Result<string, EncryptionError>> {
    const ready = await this.ensureReady();
    if (ready.isErr()) return err(ready.error);
    return this.doHash(ready.value, data);
  }

  private doEncrypt(key: Buffer, plaintext: string): Result<string, EncryptionError> {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const encoded = Buffer.concat([iv, authTag, encrypted]).toString("base64");
      // Round-trip verify — decrypt inline (independent decipher instance) to catch encoding bugs at write time
      const buf = Buffer.from(encoded, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(buf.subarray(12, 28));
      const verified = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf-8");
      if (verified !== plaintext) {
        this.logger.error("[EncryptionManager] encrypt: round-trip verification failed", { code: "encryption.roundtrip_failed", plaintextLength: plaintext.length });
        return err({ kind: "crypto_failed", cause: new Error("Encryption round-trip verification failed") });
      }
      return ok(encoded);
    } catch (e) {
      this.logger.error("[EncryptionManager] encrypt failed", { code: "encryption.encrypt_failed", error: e, plaintextLength: plaintext.length });
      return err({ kind: "crypto_failed", cause: e });
    }
  }

  private doDecrypt(key: Buffer, encoded: string): Result<string, EncryptionError> {
    try {
      const buf = Buffer.from(encoded, "base64");
      const iv = buf.subarray(0, 12);
      const authTag = buf.subarray(12, 28);
      const ciphertext = buf.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      decipher.setAuthTag(authTag);
      return ok(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8"));
    } catch (e) {
      this.logger.error("[EncryptionManager] decrypt failed — ciphertext may be corrupted or encrypted with a different key", { code: "encryption.decrypt_failed", error: e, ciphertextLength: encoded.length });
      return err({ kind: "crypto_failed", cause: e });
    }
  }

  private doHash(key: Buffer, data: string): Result<string, EncryptionError> {
    try {
      return ok(createHmac("sha256", key).update(data).digest("base64url"));
    } catch (e) {
      this.logger.error("[EncryptionManager] hash failed", { code: "encryption.hash_failed", error: e, dataLength: data.length });
      return err({ kind: "crypto_failed", cause: e });
    }
  }
}
